// Compatibility entry point. Output naming and lifecycle are owned by package-local.mjs.
import { packageVsix } from './package-local.mjs';
if (process.argv.length !== 2) {
  console.error('Filenames are now automatic. Use: npm run package:vsix -- darwin-arm64');
  process.exitCode = 1;
} else {
  try { await packageVsix({ target: 'darwin-arm64' }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
