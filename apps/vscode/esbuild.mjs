// esbuild bundler for the C Repair VS Code extension.
//
// Output: a single CJS file at dist/extension.js. VS Code loads the extension
// entry point as CommonJS, so we bundle everything (including the pure-ESM
// @c-repair/core and the @c-repair/contract types) into one CJS file. Only the
// `vscode` module is external — it is provided by the host at runtime.

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
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

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await build(options);
}
