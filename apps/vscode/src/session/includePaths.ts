// Pure assembly of the `compile_include_paths` list the extension sends to the
// bridge (D-020). Kept free of the `vscode` module so it is unit testable under
// plain Node, mirroring bridge/overrideEnv.ts.
//
// The bridge merges these into the effective compile config's include_paths (as
// `-I` args) for the baseline pre-check + candidate compile gate. Real projects
// keep missing declarations in project headers, so the scanned file's own
// directory is auto-included by default (crepair.autoIncludeFileDir), and the
// user can add more via crepair.compileIncludePaths.

/** The two include-path settings, already read from configuration. */
export interface IncludePathSettings {
  /** `crepair.compileIncludePaths` — explicit `-I` paths passed to the compiler. */
  compileIncludePaths: string[];
  /** `crepair.autoIncludeFileDir` — auto-add the scanned file's directory. */
  autoIncludeFileDir: boolean;
}

/** The verified defaults (must match package.json contributes.configuration). */
export const DEFAULT_INCLUDE_PATH_SETTINGS: IncludePathSettings = {
  compileIncludePaths: [],
  autoIncludeFileDir: true,
};

/**
 * Build the `compile_include_paths` array for a bridge request.
 *
 * Order: the auto file directory first (when enabled and available), then the
 * configured paths, trimmed and de-duplicated (first-seen order preserved).
 * Blank entries are dropped. `fileDir` is the directory of the scanned file, or
 * undefined when the source is not a real file (e.g. an untitled / non-`file`
 * scheme document) — in that case no auto directory is added.
 *
 * Returns [] when nothing applies, so a default configuration on a non-file
 * document sends an empty list (pre-D-020 behaviour).
 */
export function buildCompileIncludePaths(
  settings: IncludePathSettings,
  fileDir: string | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const p = raw.trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  if (settings.autoIncludeFileDir && fileDir) push(fileDir);
  for (const p of settings.compileIncludePaths) push(p);

  return out;
}
