// Mocha runner invoked inside the Extension Host (VSCODE_V1B_DESIGN §7). Bundled
// to CJS by esbuild (dist-test/suite/index.js) since the host loads CommonJS.

import Mocha from 'mocha';
import { activation } from './activation.test';
import { integration } from './integration.test';
import { resetState } from './resetState.test';
import { contextReview } from './contextReview.test';
import { autoRepairQueue } from './autoRepairQueue.test';
import { dedupeInclude } from './dedupeInclude.test';
import { judgmentGate } from './judgmentGate.test';
import { validationLens } from './validationLens.test';
import { modelMode } from './modelMode.test';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30_000 });
  // Register the suites programmatically (no glob — everything is bundled in).
  activation(mocha.suite);
  integration(mocha.suite);
  // Reset Extension State: runs in the default 'ready'/'empty' modes and clears the
  // seeded key + live session; placed before every mode-flipping suite. It reseeds
  // its own key in beforeAll, so a later suite that expects a key still works
  // (each suite seeds its own).
  resetState(mocha.suite);
  contextReview(mocha.suite);
  // D-024 auto-repair queue: runs in the default 'ready' repair mode, so it must
  // come before judgmentGate flips the shared bridge to semantic-fail.
  autoRepairQueue(mocha.suite);
  // D-026 duplicate-include: flips the shared bridge to 'dedupe-include' and resets
  // to 'ready' in afterAll. Placed after the default-mode suites and before the
  // semantic-fail suite (each mode-flipping suite restores 'ready' when done).
  dedupeInclude(mocha.suite);
  // D-023: it flips the shared bridge to semantic-fail repair mode and resets it to
  // 'ready' in afterAll, so it must not run before the default-mode suites.
  judgmentGate(mocha.suite);
  // Validation CodeLens: flips the shared bridge (semantic-fail -> all-pass) and
  // resets to 'ready' in afterAll. Runs after every other mode-flipping suite.
  validationLens(mocha.suite);
  // D-031 model-mode selection: only scans (repair mode irrelevant) and mutates the
  // model/provider config, restoring the defaults in afterAll. Runs last so its
  // per-test Reset Extension State + config writes disturb no other suite.
  modelMode(mocha.suite);
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
      else resolve();
    });
  });
}
