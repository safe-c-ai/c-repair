// Bridge bootstrap (V3a, D-036 / V3_PACKAGING_DESIGN §1-2): provision a
// self-contained bridge environment under the extension's globalStorage —
// uv detection (consent-gated official installer when absent) -> `uv venv
// <globalStorage>/bridge-venv` -> install the vsix-bundled wheels from
// `bridge-dist/` -> the caller then starts the bridge and verifies /health.
//
// Everything here is `vscode`-free and dependency-injected (exec / fs probes /
// the consent prompt / the progress reporter), so the resolution order and the
// bootstrap stages are unit tested under plain Node with fakes. extension.ts
// owns the VS Code side (QuickPick consent, withProgress, running the bridge).
//
// SECURITY: no secret ever reaches this module — bootstrap runs uv/installer
// commands only (no token, no API key). Command lines are loggable as-is.

import * as path from 'node:path';

// --- python resolution (D-036 order) -----------------------------------------

/** The provisioned venv directory under the extension's globalStorage. */
export function provisionedVenvDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'bridge-venv');
}

/** The python interpreter inside the provisioned venv (platform layout). */
export function provisionedPythonPath(
  globalStorageDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const venv = provisionedVenvDir(globalStorageDir);
  return platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

/** The vsix-bundled wheel directory (V3b builds it; V3a reads the dev-tree path). */
export function bridgeDistDir(extensionDir: string): string {
  return path.join(extensionDir, 'bridge-dist');
}

export type PythonResolution =
  | { kind: 'configured'; python: string }
  | { kind: 'configured_missing'; message: string }
  | { kind: 'repo'; python: string }
  | { kind: 'provisioned'; python: string }
  | { kind: 'bootstrap_needed'; message: string };

/**
 * Resolve the bridge python per the D-036 order:
 *   ① `crepair.bridge.pythonPath` (explicit; a missing file is an ERROR, not a
 *      fallthrough — an explicit setting must never be silently ignored),
 *   ② the monorepo dev venv (`<workspace>/services/repair-api/.venv`),
 *   ③ the provisioned venv under globalStorage (end users, after bootstrap),
 *   ④ none -> bootstrap guidance (the caller points at `C Repair: Set Up
 *      Bridge`).
 *
 * Pure: all environment access is injected (`exists`, folders, platform).
 */
export function resolveBridgePython(opts: {
  configuredPath: string;
  workspaceFolders: string[];
  globalStorageDir: string | undefined;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}): PythonResolution {
  const configured = opts.configuredPath.trim();
  if (configured) {
    if (!opts.exists(configured)) {
      return {
        kind: 'configured_missing',
        message:
          `The configured Python interpreter was not found: ${configured}. ` +
          `Update "crepair.bridge.pythonPath".`,
      };
    }
    return { kind: 'configured', python: configured };
  }

  const rel =
    opts.platform === 'win32'
      ? path.join('services', 'repair-api', '.venv', 'Scripts', 'python.exe')
      : path.join('services', 'repair-api', '.venv', 'bin', 'python');
  for (const folder of opts.workspaceFolders) {
    const candidate = path.join(folder, rel);
    if (opts.exists(candidate)) return { kind: 'repo', python: candidate };
  }

  if (opts.globalStorageDir) {
    const provisioned = provisionedPythonPath(opts.globalStorageDir, opts.platform);
    if (opts.exists(provisioned)) return { kind: 'provisioned', python: provisioned };
  }

  return {
    kind: 'bootstrap_needed',
    message:
      'The C Repair bridge is not set up yet. Run "C Repair: Set Up Bridge" to ' +
      'provision it automatically, or set "crepair.bridge.pythonPath" to a Python ' +
      'interpreter with repair-api installed. See the extension README.',
  };
}

// --- bootstrap stages ---------------------------------------------------------

/** Result of one executed command (injected runner; never throws). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected command runner. `shell` commands are trusted constants (installer). */
export type ExecFn = (cmd: string, args: string[], opts?: { shell?: boolean }) => Promise<ExecResult>;

/** Stage identifiers for human-readable failure messages (design §2 V3a/V3b). */
export type BootstrapStage =
  | 'uv_missing'
  | 'uv_install'
  | 'wheels_missing'
  | 'wheels_corrupt'
  | 'venv'
  | 'install';

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly stage: BootstrapStage,
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** All the effects the bootstrap needs, injected so tests use fakes. */
export interface BootstrapDeps {
  exec: ExecFn;
  exists: (p: string) => boolean;
  /** The `.whl` file paths inside a directory ([] when the dir is absent). */
  listWheels: (dir: string) => string[];
  /** UTF-8 file contents, or undefined when unreadable/absent (MANIFEST read). */
  readFile: (p: string) => string | undefined;
  /** Hex sha256 of a file's bytes, or undefined when unreadable (V3b verify). */
  fileSha256: (p: string) => string | undefined;
  mkdirp: (dir: string) => void;
  platform: NodeJS.Platform;
  homeDir: string;
  /**
   * Ask the user to consent to running uv's OFFICIAL installer (QuickPick in
   * production — no modal, per the existing D-028 policy). False = declined.
   */
  confirmInstallUv: () => Promise<boolean>;
  /** Progress line reporter (withProgress in production, a sink in tests). */
  report: (message: string) => void;
}

// --- wheel manifest (V3b) ----------------------------------------------------

/** One MANIFEST.json entry: a bundled wheel + its expected content hash. */
export interface ManifestEntry {
  file: string;
  sha256: string;
}

/**
 * Parse `bridge-dist/MANIFEST.json` (written by tools/build-bridge-dist.sh:
 * `{"format": 1, "files": [{"file", "sha256", "size"}]}`). Returns the entries
 * or undefined when the shape is not the pinned format-1 (the caller maps that
 * to a `wheels_corrupt` error). Unknown extra keys are tolerated; `file` and a
 * 64-hex `sha256` are required per entry.
 */
export function parseManifest(text: string): ManifestEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const obj = data as { format?: unknown; files?: unknown };
  if (obj.format !== 1 || !Array.isArray(obj.files)) return undefined;
  const out: ManifestEntry[] = [];
  for (const raw of obj.files) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const e = raw as { file?: unknown; sha256?: unknown };
    if (typeof e.file !== 'string' || !e.file.endsWith('.whl')) return undefined;
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return undefined;
    out.push({ file: e.file, sha256: e.sha256 });
  }
  return out;
}

/** The uv install documentation shown when the user declines the installer. */
export const UV_MANUAL_INSTALL_URL = 'https://docs.astral.sh/uv/getting-started/installation/';

// Official installer one-liners (uv docs). Trusted constants — never built from
// user input; executed only after explicit consent.
const UV_INSTALL_POSIX = 'curl -LsSf https://astral.sh/uv/install.sh | sh';
const UV_INSTALL_WINDOWS = 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"';

/**
 * Classify a failed command's stderr into a human-readable cause suffix.
 * Network vs disk are the two failure families the design calls out; anything
 * else falls back to the raw (trimmed) stderr tail.
 */
export function failureDetail(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/enospc|no space left|disk full|quota/.test(s)) {
    return 'the disk appears to be full — free some space and retry';
  }
  if (
    /network|could not resolve|connection|connect|timed out|timeout|tls|ssl|curl: \(|proxy|dns/.test(
      s,
    )
  ) {
    return 'a network problem occurred (check connectivity / proxy) and retry';
  }
  const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return tail ? `details: ${tail}` : 'no further details were reported';
}

/**
 * Find a usable uv binary: `uv` on PATH, else the official installer's default
 * location (`~/.local/bin/uv[.exe]`) — the spawning process's PATH does not
 * pick up a just-installed uv, so the known location is probed explicitly.
 * Returns the command to run, or undefined when uv is not available.
 */
export async function findUv(deps: Pick<BootstrapDeps, 'exec' | 'exists' | 'platform' | 'homeDir'>): Promise<string | undefined> {
  const onPath = await deps.exec('uv', ['--version']);
  if (onPath.code === 0) return 'uv';
  const local = path.join(
    deps.homeDir,
    '.local',
    'bin',
    deps.platform === 'win32' ? 'uv.exe' : 'uv',
  );
  if (deps.exists(local)) {
    const probe = await deps.exec(local, ['--version']);
    if (probe.code === 0) return local;
  }
  return undefined;
}

/**
 * Run the full bootstrap (design §1-2): ensure uv (consent-gated installer) ->
 * `uv venv` under globalStorage -> install the bundled wheels. Returns the
 * provisioned python path; throws `BootstrapError` with a stage + a
 * human-readable message on any failure. The caller verifies /health after.
 *
 * The wheels come from the vsix-bundled `bridge-dist/` (V3b generates it; in
 * the V3a dev tree the directory simply may not exist yet — dev environments
 * resolve the repo `.venv` FIRST, so this path is not on the normal dev route,
 * and the missing-dist error explains that plainly).
 */
export async function runBootstrap(
  deps: BootstrapDeps,
  dirs: { globalStorageDir: string; extensionDir: string },
): Promise<{ venvPython: string }> {
  // 1. Wheels first: fail fast BEFORE installing anything when the vsix has no
  //    bridge-dist (nothing could be installed into the venv anyway), and
  //    verify each bundled wheel against MANIFEST.json (V3b, D-036 pin): only
  //    manifest-listed, hash-matching wheels are ever installed.
  const dist = bridgeDistDir(dirs.extensionDir);
  const wheels = deps.listWheels(dist);
  if (wheels.length === 0) {
    throw new BootstrapError(
      `No bridge wheels were found at ${dist}. This build of the extension does ` +
        'not bundle the bridge distribution (bridge-dist/ is produced by the ' +
        'packaging step). If you are developing in the monorepo, create the ' +
        'repair-api virtualenv instead (services/repair-api/.venv) — it takes ' +
        'priority and no bootstrap is needed.',
      'wheels_missing',
    );
  }
  deps.report('Verifying the bundled bridge packages…');
  const manifestText = deps.readFile(path.join(dist, 'MANIFEST.json'));
  if (manifestText === undefined) {
    throw new BootstrapError(
      `Bridge wheels are present at ${dist} but MANIFEST.json is missing — the ` +
        'bundle is incomplete or damaged. Reinstall the extension (the packaging ' +
        'step writes the manifest alongside the wheels).',
      'wheels_corrupt',
    );
  }
  const manifest = parseManifest(manifestText);
  if (manifest === undefined || manifest.length === 0) {
    throw new BootstrapError(
      `MANIFEST.json at ${dist} is not in the expected format — the bundle is ` +
        'damaged. Reinstall the extension.',
      'wheels_corrupt',
    );
  }
  const verifiedWheels: string[] = [];
  for (const entry of manifest) {
    const wheelPath = path.join(dist, entry.file);
    const actual = deps.exists(wheelPath) ? deps.fileSha256(wheelPath) : undefined;
    if (actual !== entry.sha256) {
      throw new BootstrapError(
        `The bundled bridge package ${entry.file} ${
          actual === undefined ? 'is missing' : 'does not match its recorded checksum'
        } — the bundle is damaged. Reinstall the extension.`,
        'wheels_corrupt',
      );
    }
    verifiedWheels.push(wheelPath);
  }

  // 2. uv: PATH, known install location, or the official installer (consented).
  deps.report('Checking for uv…');
  let uv = await findUv(deps);
  if (!uv) {
    const consented = await deps.confirmInstallUv();
    if (!consented) {
      throw new BootstrapError(
        'uv is required to set up the bridge and was not installed. Install uv ' +
          `manually (${UV_MANUAL_INSTALL_URL}) and run "C Repair: Set Up Bridge" again.`,
        'uv_missing',
      );
    }
    deps.report('Installing uv (official installer)…');
    const installCmd = deps.platform === 'win32' ? UV_INSTALL_WINDOWS : UV_INSTALL_POSIX;
    const installed = await deps.exec(installCmd, [], { shell: true });
    if (installed.code !== 0) {
      throw new BootstrapError(
        `The uv installer failed — ${failureDetail(installed.stderr)}.`,
        'uv_install',
      );
    }
    uv = await findUv(deps);
    if (!uv) {
      throw new BootstrapError(
        'uv was installed but could not be located afterwards. Restart VS Code ' +
          `(so PATH refreshes) or install uv manually (${UV_MANUAL_INSTALL_URL}).`,
        'uv_install',
      );
    }
  }

  // 3. Create the venv under globalStorage.
  deps.report('Creating the bridge environment…');
  deps.mkdirp(dirs.globalStorageDir);
  const venvDir = provisionedVenvDir(dirs.globalStorageDir);
  const venv = await deps.exec(uv, ['venv', '--python', '3.10', venvDir]);
  if (venv.code !== 0) {
    throw new BootstrapError(
      `Creating the bridge environment failed — ${failureDetail(venv.stderr)}.`,
      'venv',
    );
  }

  // 4. Install the VERIFIED wheels into the venv (uv resolves their deps).
  deps.report(
    `Installing the bridge (${verifiedWheels.length} package file${verifiedWheels.length === 1 ? '' : 's'})…`,
  );
  const venvPython = provisionedPythonPath(dirs.globalStorageDir, deps.platform);
  // --reinstall: bundled wheel versions stay constant across extension
  // updates, so without it a repaired wheel would be skipped as "already
  // satisfied" and a stale bridge would keep running (Windows smoke,
  // 2026-08-24).
  const install = await deps.exec(uv, ['pip', 'install', '--reinstall', '--python', venvPython, ...verifiedWheels]);
  if (install.code !== 0) {
    throw new BootstrapError(
      `Installing the bridge packages failed — ${failureDetail(install.stderr)}.`,
      'install',
    );
  }

  return { venvPython };
}
