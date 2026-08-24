// Bridge lifecycle manager (VSCODE_V1B_DESIGN.md §2):
//   1. resolve the Python interpreter
//   2. reserve a free ephemeral port
//   3. spawn `python -m uvicorn repair_api.main:app` with the token + API key
//      passed via ENVIRONMENT VARIABLES ONLY (never argv / logs)
//   4. poll /health (Bearer) until ready (max 15s), then check contract_version
//      (fatal on mismatch) and the harness pin (0.4.x → warn + continue)
//   5. monitor the child's exit; kill on deactivate.
//
// SECURITY: the Bearer token and OPENROUTER_API_KEY are placed only in the child's
// env. They are never written to the command line, the Output channel, or any
// setting. The Output channel receives lifecycle events (starting/ready/exit)
// and hashes/counts only — never the token, key, or source content.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { BridgeClient } from './BridgeClient';
import { resolveBridgePython } from './bootstrap';
import { checkHealthCompat, harnessPinLabel, type HealthResponse } from './health';
import {
  buildFreeModelEnv,
  buildModeOverrideEnv,
  DEFAULT_OVERRIDES,
  normalizeModelMode,
  normalizeProviderPolicy,
  type ModelMode,
  type OverrideSettings,
} from './overrideEnv';
import { logError, logInfo, logWarn } from '../log';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const HANDSHAKE_POLL_INTERVAL_MS = 300;

export type BridgeState = 'stopped' | 'starting' | 'ready' | 'error';

export interface BridgeHandle {
  client: BridgeClient;
  health: HealthResponse;
  baseUrl: string;
}

/** Thrown when the bridge cannot be configured / started; message is user-safe. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'handshake' | 'incompatible' | 'spawn',
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class BridgeManager {
  private child: ChildProcess | undefined;
  private handle: BridgeHandle | undefined;
  private starting: Promise<BridgeHandle> | undefined;
  private stateListeners: ((s: BridgeState) => void)[] = [];
  private _state: BridgeState = 'stopped';
  /**
   * The free model to force on spawn (B, free-model auto-run), or undefined for the
   * normal (config-derived) construction. When set, the spawn env pins
   * CREPAIR_MODEL_ID=<freeModel> and CREPAIR_PROVIDER_ORDER="" (automatic routing),
   * overriding the config model/provider. Set via `setFreeModel`, which kills the
   * child so the next `ensureStarted` respawns in the chosen construction.
   */
  private freeModel: string | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    /**
     * The extension's globalStorage path (V3a, D-036): hosts the provisioned
     * `bridge-venv/` that `C Repair: Set Up Bridge` creates. Optional so unit
     * constructions without a storage dir keep working (resolution then simply
     * skips step ③).
     */
    private readonly globalStorageDir?: string,
  ) {}

  get state(): BridgeState {
    return this._state;
  }

  /** Whether the bridge is currently configured to run the free model (B). */
  get onFreeModel(): boolean {
    return this.freeModel !== undefined;
  }

  /**
   * Select (or clear) the free-model construction for the NEXT spawn (B). Passing a
   * model string arms the free env (model pin + automatic routing); passing
   * undefined returns to the normal config-derived construction. When the target
   * construction differs from the current one, the running child is killed so the
   * next `ensureStarted` respawns in the new construction. Idempotent: a no-op when
   * the requested construction already matches.
   */
  setFreeModel(freeModel: string | undefined): void {
    const next = freeModel && freeModel.trim() ? freeModel.trim() : undefined;
    if (next === this.freeModel) return; // already in the requested construction
    this.freeModel = next;
    // Force a respawn in the new construction on the next ensureStarted().
    this.kill();
  }

  onStateChange(fn: (s: BridgeState) => void): vscode.Disposable {
    this.stateListeners.push(fn);
    return new vscode.Disposable(() => {
      this.stateListeners = this.stateListeners.filter((l) => l !== fn);
    });
  }

  private setState(s: BridgeState): void {
    this._state = s;
    for (const l of this.stateListeners) l(s);
  }

  /**
   * Ensure the bridge is running and return a handle. Idempotent: returns the
   * live handle if the child is still alive, otherwise (re)spawns. Concurrent
   * callers share one start.
   */
  async ensureStarted(): Promise<BridgeHandle> {
    if (this.handle && this.child && this.child.exitCode === null) {
      return this.handle;
    }
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<BridgeHandle> {
    this.setState('starting');
    try {
      // TEST-ONLY hook (VSCODE_V1B_DESIGN §7): when CREPAIR_TEST_BRIDGE_URL is
      // set, connect to that already-running (fixture) bridge instead of
      // spawning python. This keeps the integration suite deterministic and
      // offline. In production the env var is unset, so this branch never runs
      // and behaviour is unchanged (no python spawn is skipped, no auth relaxed —
      // the test bridge itself is trusted and local).
      const testUrl = process.env.CREPAIR_TEST_BRIDGE_URL;
      if (testUrl) {
        const handle = await this.connectExisting(testUrl.replace(/\/+$/, ''));
        this.handle = handle;
        this.setState('ready');
        return handle;
      }

      const python = this.resolvePython();
      const port = this.configuredPort() || (await reserveFreePort());
      const apiKey = await this.secrets.get(API_KEY_SECRET);
      const token = randomUUID();

      const handle = await this.spawnAndHandshake(python, port, token, apiKey);
      this.handle = handle;
      this.setState('ready');
      return handle;
    } catch (err) {
      this.setState('error');
      throw err;
    }
  }

  /**
   * TEST-ONLY: attach to an already-running bridge at `baseUrl` (no spawn). The
   * handshake still runs, so contract/version compatibility is exercised. The
   * Bearer token is read from CREPAIR_TEST_BRIDGE_TOKEN (empty when the test
   * bridge is unauthenticated).
   */
  private async connectExisting(baseUrl: string): Promise<BridgeHandle> {
    const token = process.env.CREPAIR_TEST_BRIDGE_TOKEN ?? '';
    const client = new BridgeClient(baseUrl, token);
    const health = await client.health();
    const compat = checkHealthCompat(health);
    if (!compat.ok) throw new BridgeError(compat.reason, 'incompatible');
    logInfo(`Connected to test bridge at ${baseUrl}.`);
    return { client, health: compat.health, baseUrl };
  }

  /**
   * Resolve the Python interpreter (VSCODE_V1B_DESIGN §2.1, extended by V3a /
   * D-036 to the 4-step order: ① explicit setting → ② repo .venv → ③ the
   * provisioned globalStorage venv → ④ bootstrap guidance). The pure order
   * logic lives in `resolveBridgePython` (unit tested); this wrapper feeds it
   * the live workspace/config and maps the non-python outcomes to BridgeError.
   */
  private resolvePython(): string {
    const configured = vscode.workspace
      .getConfiguration('crepair')
      .get<string>('bridge.pythonPath', '')
      .trim();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const resolution = resolveBridgePython({
      configuredPath: configured,
      workspaceFolders: folders,
      globalStorageDir: this.globalStorageDir,
      platform: process.platform,
      exists: (p) => fs.existsSync(p),
    });
    switch (resolution.kind) {
      case 'configured':
      case 'repo':
      case 'provisioned':
        return resolution.python;
      case 'configured_missing':
        throw new BridgeError(resolution.message, 'not_configured');
      case 'bootstrap_needed':
        throw new BridgeError(resolution.message, 'not_configured');
    }
  }

  private configuredPort(): number {
    const p = vscode.workspace.getConfiguration('crepair').get<number>('bridge.port', 0);
    return typeof p === 'number' && p > 0 ? p : 0;
  }

  /** Read the D-019 model/provider + D-028 reasoning settings from configuration. */
  private overrideSettings(): OverrideSettings {
    const cfg = vscode.workspace.getConfiguration('crepair');
    return {
      model: cfg.get<string>('model', DEFAULT_OVERRIDES.model),
      providerOrder: cfg.get<string[]>('providerOrder', DEFAULT_OVERRIDES.providerOrder),
      allowFallbacks: cfg.get<boolean>('allowFallbacks', DEFAULT_OVERRIDES.allowFallbacks),
      configPath: cfg.get<string>('bridge.configPath', DEFAULT_OVERRIDES.configPath),
      reasoningEffort: cfg.get<string>('reasoningEffort', DEFAULT_OVERRIDES.reasoningEffort),
      providerPolicy: normalizeProviderPolicy(cfg.get<string>('providerPolicy')),
    };
  }

  /** Read the D-031 `crepair.modelMode` (default `default`). */
  private modelMode(): ModelMode {
    return normalizeModelMode(
      vscode.workspace.getConfiguration('crepair').get<string>('modelMode'),
    );
  }

  /** Read `crepair.freeModel` (used to build the free-mode env). */
  private configuredFreeModel(): string {
    return vscode.workspace.getConfiguration('crepair').get<string>('freeModel', '');
  }

  private async spawnAndHandshake(
    python: string,
    port: number,
    token: string,
    apiKey: string | undefined,
  ): Promise<BridgeHandle> {
    const baseUrl = `http://127.0.0.1:${port}`;
    // Token + API key are passed via env ONLY. argv carries no secret.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CREPAIR_BRIDGE_TOKEN: token,
      // Windows: the default locale encoding is cp932/etc., and the certfix
      // engine reads its YAML config with open(path) (no encoding), so any
      // non-ASCII byte in a config 500s /health (observed live on the first
      // Windows smoke, 2026-08-24). UTF-8 mode makes Python read/write UTF-8
      // everywhere regardless of locale; harmless on Linux/macOS.
      PYTHONUTF8: '1',
    };
    if (apiKey) env.OPENROUTER_API_KEY = apiKey;

    // D-031 model-mode overrides. `crepair.modelMode` is the source of truth: in
    // `default` mode NO model/provider var is emitted (bundled config verbatim); in
    // `free` mode the free model + automatic routing are pinned; in `custom` mode the
    // legacy per-setting mapping applies. Only vars that DIFFER from the verified
    // defaults are emitted, so a default configuration passes no CREPAIR_* override.
    // Model / provider ids only — never a secret; safe to log the keys.
    const overrideEnv = buildModeOverrideEnv(
      this.modelMode(),
      this.overrideSettings(),
      this.configuredFreeModel(),
    );
    Object.assign(env, overrideEnv);
    // B (creditless auto-fallback, default mode only): when armed, the free env is
    // applied ON TOP of the mode env, pinning the free model + automatic routing (the
    // DeepInfra pin cannot serve :free models). Only armed while modelMode=default and
    // the key has no credits AND the user did not set an explicit model.
    if (this.freeModel) {
      Object.assign(env, buildFreeModelEnv(this.freeModel));
    }
    const overrideKeys = Object.keys({ ...overrideEnv, ...(this.freeModel ? buildFreeModelEnv(this.freeModel) : {}) });

    logInfo(
      `Starting bridge: uvicorn on 127.0.0.1:${port} ` +
        `(api key ${apiKey ? 'present' : 'absent'}` +
        `${this.freeModel ? `, free model: ${this.freeModel}` : ''}` +
        `${overrideKeys.length ? `, overrides: ${overrideKeys.join(', ')}` : ', default config'}).`,
    );

    const child = spawn(
      python,
      ['-m', 'uvicorn', 'repair_api.main:app', '--host', '127.0.0.1', '--port', String(port)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    // Capture stderr lines for crash diagnostics — but never echo source content
    // (uvicorn/app logging is hash/line-number only by design, main.py §Stop-line).
    child.stderr?.on('data', (buf: Buffer) => {
      const line = buf.toString('utf8').trimEnd();
      if (line) logInfo(`[uvicorn] ${line}`);
    });
    child.on('exit', (code, signal) => {
      const wasReady = this.handle !== undefined;
      this.handle = undefined;
      this.setState(wasReady ? 'error' : 'error');
      logWarn(`Bridge process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
    });
    child.on('error', (err) => {
      logError(`Failed to spawn bridge process: ${err.message}`);
    });

    const client = new BridgeClient(baseUrl, token);
    const health = await this.pollHealth(client, child);

    const compat = checkHealthCompat(health);
    if (!compat.ok) {
      this.kill();
      throw new BridgeError(compat.reason, 'incompatible');
    }
    if (!compat.harnessInPin) {
      const msg =
        `The harness version ${compat.health.harness.version} is outside the ` +
        `pinned range ${harnessPinLabel()}. Continuing, but results may differ. ` +
        `(The extension does not auto-update the harness.)`;
      logWarn(msg);
      void vscode.window.showWarningMessage(`C Repair: ${msg}`);
    }
    logInfo(
      `Bridge ready: harness ${compat.health.harness.id} ${compat.health.harness.version}, ` +
        `adapter ${compat.health.adapter.id} ${compat.health.adapter.version}, ` +
        `rules ${compat.health.capabilities.rules_count}.`,
    );
    return { client, health: compat.health, baseUrl };
  }

  /** Poll /health until it answers, the child exits, or the timeout elapses. */
  private async pollHealth(client: BridgeClient, child: ChildProcess): Promise<unknown> {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new BridgeError(
          `The bridge process exited during startup (code ${child.exitCode}). ` +
            `Check the "C Repair" Output channel.`,
          'spawn',
        );
      }
      try {
        return await client.health();
      } catch (err) {
        lastErr = (err as Error).message;
        await delay(HANDSHAKE_POLL_INTERVAL_MS);
      }
    }
    this.kill();
    throw new BridgeError(
      `The bridge did not become ready within ${HANDSHAKE_TIMEOUT_MS / 1000}s. ` +
        `Last error: ${lastErr}`,
      'handshake',
    );
  }

  /** Terminate the child process (idempotent). Called on deactivate. */
  kill(): void {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        // best-effort
      }
    }
    this.child = undefined;
    this.handle = undefined;
    if (this._state !== 'error') this.setState('stopped');
  }

  dispose(): void {
    this.kill();
    this.stateListeners = [];
  }
}

/** The SecretStorage key for the OpenRouter API key (VSCODE_V1B_DESIGN §6). */
export const API_KEY_SECRET = 'crepair.openrouterApiKey';

/**
 * Reserve a free ephemeral port by listening on 0 then closing. There is an
 * inherent TOCTOU race, but for a locally-spawned uvicorn this is standard and
 * acceptable (VSCODE_V1B_DESIGN §2.2).
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not determine a free port.')));
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
