// esbuild bundler for the @vscode/test-electron suite. Bundles the Mocha suite
// (including mocha itself) into a single CJS file loaded by the Extension Host.
// `vscode` is external (provided by the host).

import { build } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['test/electron/suite/index.ts'],
  bundle: true,
  outfile: 'dist-test/suite/index.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

await build(options);
