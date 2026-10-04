// esbuild bundler for the C Repair VS Code extension.
//
// Output: a single CJS file at dist/extension.js. VS Code loads the extension
// entry point as CommonJS, so we bundle everything (including the pure-ESM
// @c-repair/core and the @c-repair/contract types) into one CJS file. Only the
// `vscode` module is external — it is provided by the host at runtime.

import { build, context } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  // The `vscode` module is injected by the Extension Host; never bundle it.
  external: ['vscode'],
  logLevel: 'info',
};

// Packaging builds into an isolated OS temporary directory, leaving F5/watch output alone.
export async function buildExtension(overrides = {}) {
  return build({ ...options, ...overrides });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await buildExtension();
  }
}
