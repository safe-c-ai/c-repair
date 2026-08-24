// CI guard: user-facing text must not leak internal decision numbers (`D-<n>` /
// `D-0<n>`). Those tags are an internal planning device; a user reading a setting
// description, a notification, a QuickPick, a tooltip or a lens should never see
// them. This test asserts:
//
//   1) The whole `package.json` (every command title / description / enum
//      description) is free of any `D-<digits>` reference.
//   2) The main UI string modules carry no `D-<digits>` inside a *string* or
//      *template* literal (code comments may keep the reference — they are not
//      user-visible). Comments are stripped before the check so an explanatory
//      `// D-030 …` never trips it, but a `"… (D-030) …"` message does.
//
// A rename / new setting that reintroduces a decision tag in user text fails CI
// here instead of shipping the leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** Matches an internal decision reference: D-017, D-024, D-017b, etc. */
const DECISION_RE = /D-\d+[a-z]?/g;

/**
 * Strip `//` line comments and block comments from TypeScript source so only code
 * (identifiers + string/template literals) remains. Deliberately simple: it does
 * not track strings that contain `//`, but the UI modules have no such literals,
 * and the goal is only to avoid flagging `D-<n>` that lives in a comment. String
 * literals with a real decision tag survive stripping and are caught.
 */
function stripComments(src: string): string {
  // Block comments first (spanning lines), then line comments.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

test('package.json carries no internal decision references (D-<n>)', () => {
  const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const hits = pkg.match(DECISION_RE) ?? [];
  assert.deepEqual(
    hits,
    [],
    `package.json must not reference internal decision numbers, found: ${hits.join(', ')}`,
  );
});

// The user-facing string modules: every module that builds text a user can read
// (settings are covered by package.json above). Comments in these files may keep
// their `D-<n>` references — only literals are checked.
const UI_STRING_MODULES = [
  'src/extension.ts',
  'src/ui/statusBar.ts',
  'src/ui/tree.ts',
  'src/ui/headerMessage.ts',
  'src/ui/model.ts',
  'src/ui/validationLens.ts',
  'src/cost/sessionUsage.ts',
  'src/cost/openrouterUsage.ts',
  'src/bridge/BridgeManager.ts',
];

for (const rel of UI_STRING_MODULES) {
  test(`${rel} has no internal decision reference in a string/template literal`, () => {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    const hits = code.match(DECISION_RE) ?? [];
    assert.deepEqual(
      hits,
      [],
      `${rel} leaks an internal decision reference in user-facing text: ${hits.join(', ')}`,
    );
  });
}
