// Branding guard (D-039, revising D-037): the public display name is "C Repair"
// (no subtitle). CERT® appears only as a *referenced* supported standard
// ("Standard: CERT® C", rule ids/titles), never as part of the product name.
// Internal identifiers (crepair.* settings/commands, the extension name
// "c-repair", CREPAIR_* env, globalState keys) intentionally keep their ids —
// this guard checks the DISPLAY surfaces carry "C Repair", asserts those ids are
// unchanged, and that the retired product name "CertFix" survives nowhere in
// source or test strings (D-037's prior direction is fully reverted; the only
// sanctioned "C Repair" literal in source is the contract-pinned prelude marker,
// which is now simply the product name and needs no exemption).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEFAULT_MODE_LABEL, DEFAULT_MODE_LABEL_LOWER } from '../src/bridge/overrideEnv';
import { flatProperties, readSections } from './configSections';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, '..');

test('display surfaces carry the "C Repair" name, never "CertFix" (D-039)', () => {
  const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.displayName, 'C Repair');
  // The description states the standard support without a compliance claim (D-039):
  // CERT® C now; the word "Compliance" is deliberately absent, and future
  // plans (e.g. MISRA C) are deliberately NOT promised in the description
  // (user decision, 2026-08-24).
  assert.ok(!/compliance/i.test(pkg.description), 'description avoids "Compliance"');
  assert.ok(pkg.description.includes('CERT® C'), 'description references CERT® C');
  assert.ok(!/MISRA/.test(pkg.description), 'the description must not promise future MISRA support');
  // Internal ids stay: extension name and command/setting prefixes.
  assert.equal(pkg.name, 'c-repair');
  for (const cmd of pkg.contributes.commands) {
    assert.equal(cmd.category, 'C Repair', `${cmd.command} category`);
    assert.ok(cmd.command.startsWith('crepair.'), `${cmd.command} keeps its id`);
    assert.ok(!cmd.title.includes('CertFix'), `${cmd.command} title`);
    assert.ok(!cmd.title.includes('C Repair:'), `${cmd.command} title relies on the category`);
  }
  // Container / view / walkthrough titles all show the product name.
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].title, 'C Repair');
  assert.equal(pkg.contributes.views.crepair[0].contextualTitle, 'C Repair');
  assert.equal(pkg.contributes.walkthroughs[0].title, 'Get started with C Repair');
  // configuration is a section ARRAY (no single title); the Settings-UI group name
  // comes from the extension displayName ("C Repair", asserted above). Each section
  // carries a non-empty sub-heading and none reintroduces the retired product name.
  assert.ok(Array.isArray(pkg.contributes.configuration), 'configuration is a section array');
  for (const section of readSections()) {
    assert.ok(
      typeof section.title === 'string' && section.title.length > 0,
      'each configuration section has a non-empty title',
    );
    assert.ok(!section.title.includes('CertFix'), `section "${section.title}" avoids "CertFix"`);
  }
  // No display surface may still carry the retired product name.
  const surfaces = [
    'package.json',
    'README.md',
    'media/walkthrough/api-key.md',
    'media/walkthrough/model-mode.md',
    'media/walkthrough/bridge.md',
    'media/walkthrough/first-scan.md',
    'media/walkthrough/review-accept.md',
  ];
  for (const rel of surfaces) {
    const text = readFileSync(join(EXT_DIR, rel), 'utf8');
    assert.ok(!text.includes('CertFix'), `${rel} still says "CertFix"`);
  }
  // README carries the CERT® trademark attribution + non-affiliation (D-039).
  const readme = readFileSync(join(EXT_DIR, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('CERT® is a registered trademark of Carnegie Mellon University'),
    'README missing the CERT® trademark attribution',
  );
  assert.ok(
    /not affiliated with, sponsored, or endorsed by CMU/.test(readme),
    'README missing the non-affiliation statement',
  );
  assert.ok(
    /does not provide official conformance certification/.test(readme),
    'README missing the no-official-certification statement',
  );
});

test('the default mode displays as its label, never as "default" (D-038)', () => {
  const modeSetting = flatProperties()['crepair.modelMode'];

  // The STORED enum values are unchanged (compat: settings, tests, env mapping)…
  assert.deepEqual(modeSetting.enum, ['default', 'free', 'custom']);
  // …but the DISPLAY labels come from the single source-of-truth constant. This
  // pins package.json's static string to the code constant so a rename cannot
  // drift between the settings UI and the header/notice wording.
  assert.deepEqual(modeSetting.enumItemLabels, [DEFAULT_MODE_LABEL, 'Free', 'Custom']);
  // The label description states the release-preset semantics (may change later).
  const enumDescs = modeSetting.markdownEnumDescriptions ?? [];
  assert.match(enumDescs[0] ?? '', /preset/i);
  assert.match(enumDescs[0] ?? '', /future releases/);

  // Display surfaces name the mode by its label; the word "default" must not be
  // shown as the mode/model NAME. (Legitimate technical uses like a setting's
  // "default value" remain; the guarded phrase is "default model".)
  const surfaces = ['README.md', 'media/walkthrough/model-mode.md'];
  for (const rel of surfaces) {
    const text = readFileSync(join(EXT_DIR, rel), 'utf8');
    assert.ok(!/default model/i.test(text), `${rel} still says "default model"`);
  }
  const walkthrough = readFileSync(join(EXT_DIR, 'media/walkthrough/model-mode.md'), 'utf8');
  assert.ok(walkthrough.includes(DEFAULT_MODE_LABEL), 'model-mode.md names the mode label');
  assert.ok(!walkthrough.includes('**Default**'), 'model-mode.md still headlines "Default"');

  // package.json user-visible descriptions: no "default model" naming anywhere.
  const pkgText = readFileSync(join(EXT_DIR, 'package.json'), 'utf8');
  assert.ok(!/default model/i.test(pkgText), 'package.json still says "default model"');

  // Source string literals (user-visible messages): the phrase "default model" must
  // not survive in CODE lines; comments are exempt (not user-visible).
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts')) {
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            if (/default model/i.test(line)) offenders.push(`${p}:${i + 1}: ${t}`);
          });
      }
    }
  };
  walk(join(EXT_DIR, 'src'));
  assert.deepEqual(offenders, []);

  // Sanity: the constant is a single capitalized word and lowers cleanly (it is
  // interpolated into running text like "the <label> model").
  assert.match(DEFAULT_MODE_LABEL, /^[A-Z][a-z]+$/);
  assert.equal(DEFAULT_MODE_LABEL_LOWER, DEFAULT_MODE_LABEL.toLowerCase());
});

test('source and tests keep no "CertFix" — the product name is fully retired (D-039)', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && entry.name !== 'branding.test.ts') {
        // (This guard file itself necessarily contains the retired literal.)
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (line.includes('CertFix')) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
          });
      }
    }
  };
  walk(join(EXT_DIR, 'src'));
  walk(join(EXT_DIR, 'test'));
  assert.deepEqual(offenders, []);
});

test('internal identifiers are unchanged — the rebrand is display-only (D-037/D-039)', () => {
  const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf8'));
  // Extension name, view/container ids, and every command/setting id keep their
  // crepair.* / c-repair form regardless of the display-name history.
  assert.equal(pkg.name, 'c-repair');
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'crepair');
  assert.ok(pkg.contributes.views.crepair, 'view container id "crepair" is unchanged');
  for (const cmd of pkg.contributes.commands) {
    assert.ok(cmd.command.startsWith('crepair.'), `${cmd.command} keeps its id`);
  }
  for (const key of Object.keys(flatProperties())) {
    assert.ok(key.startsWith('crepair.'), `${key} keeps its id`);
  }
  // The stored model-mode value stays "default" (only its display label changed).
  assert.deepEqual(
    flatProperties()['crepair.modelMode'].enum,
    ['default', 'free', 'custom'],
  );
  // The contract-pinned prelude marker keeps its exact wording (CONTRACT.md /
  // fixtures depend on it; it is unaffected by the product rename).
  const marker = readFileSync(join(EXT_DIR, 'src/session/contextReviewDoc.ts'), 'utf8');
  assert.ok(marker.includes('C Repair inferred context'), 'prelude marker text is pinned');
});
