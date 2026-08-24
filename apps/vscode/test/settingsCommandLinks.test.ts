// Unit tests for the Settings-UI command links (settings screen as an
// operations hub). The configuration `markdownDescription` fields embed
// `[label](command:crepair.xxx)` links so a user who opens Settings can manage
// the SecretStorage-backed API key and run the main commands. These tests are
// load-bearing: every `command:` link MUST resolve to a real
// `contributes.commands` id, so a future command rename that forgets a link
// fails CI instead of shipping a dead link in the Settings UI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_OVERRIDES } from '../src/bridge/overrideEnv';
import { PKG_PATH, flatProperties, flatKeys, readSections } from './configSections';
import type { PkgProperty } from './configSections';

type PkgCommand = { command: string };
type Pkg = {
  contributes: {
    commands: PkgCommand[];
  };
};

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as Pkg;
// `contributes.configuration` is now a section ARRAY; flatten it to the pre-sectioning
// key→property map so these command-link / ordering guards read exactly as before.
const properties = flatProperties();

/** All command ids declared in contributes.commands. */
function declaredCommandIds(): Set<string> {
  return new Set(pkg.contributes.commands.map((c) => c.command));
}

/** Every markdown string that can carry a command link (descriptions + enum descriptions). */
function allMarkdownStrings(): string[] {
  const out: string[] = [];
  for (const prop of Object.values(properties)) {
    if (prop.markdownDescription) out.push(prop.markdownDescription);
    if (prop.markdownEnumDescriptions) out.push(...prop.markdownEnumDescriptions);
  }
  return out;
}

/**
 * Extract command ids from `[label](command:ID)` / `[label](command:ID?args)`
 * links inside a markdown string. The id runs until `?`, `)` or whitespace.
 */
function commandLinksIn(md: string): string[] {
  const ids: string[] = [];
  const re = /\]\(command:([^)?\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) ids.push(m[1]);
  return ids;
}

function allCommandLinks(): string[] {
  return allMarkdownStrings().flatMap(commandLinksIn);
}

test('every command: link in a markdownDescription resolves to a declared command id', () => {
  const declared = declaredCommandIds();
  const links = allCommandLinks();
  // Guard against a regex/data regression that would make the test vacuous.
  assert.ok(links.length > 0, 'expected at least one command: link in the configuration');
  for (const id of links) {
    assert.ok(
      declared.has(id),
      `command link "command:${id}" has no matching contributes.commands entry`,
    );
  }
});

test('the API key info panel links all three key-management commands', () => {
  const md = properties['crepair.apiKey']?.markdownDescription ?? '';
  const ids = new Set(commandLinksIn(md));
  for (const id of [
    'crepair.connectOpenRouter',
    'crepair.setApiKey',
    'crepair.clearApiKey',
  ]) {
    assert.ok(ids.has(id), `API key panel is missing a link to ${id}`);
  }
});

test('the Commands info panel links the main operations', () => {
  const md = properties['crepair.commands']?.markdownDescription ?? '';
  const ids = new Set(commandLinksIn(md));
  for (const id of [
    'crepair.scanCurrentFile',
    'crepair.scanAndFixCurrentFile',
    'crepair.editContext',
    'crepair.chooseModelMode',
    'crepair.resetExtensionState',
  ]) {
    assert.ok(ids.has(id), `Commands panel is missing a link to ${id}`);
  }
});

test('crepair.model links the leaderboard first (recommended) then OpenRouter rankings', () => {
  const md = properties['crepair.model']?.markdownDescription ?? '';
  const leaderboard = 'https://safe-c-ai.github.io/c-repair-leaderboard/cert-c/';
  const rankings = 'https://openrouter.ai/rankings';
  const li = md.indexOf(leaderboard);
  const ri = md.indexOf(rankings);
  assert.ok(li !== -1, 'model description is missing the C Repair Leaderboard link');
  assert.ok(ri !== -1, 'model description is missing the OpenRouter Rankings link');
  // The leaderboard is the recommended basis, so it must come first.
  assert.ok(li < ri, 'the leaderboard link must precede the OpenRouter rankings link');
});

test('https links in descriptions do not register as command links', () => {
  // The command-link extractor keys off `](command:` only, so https model-guidance
  // links must never be picked up as (dead) command ids.
  const md = properties['crepair.model']?.markdownDescription ?? '';
  assert.ok(md.includes('https://'), 'expected the model description to carry https links');
  assert.deepEqual(commandLinksIn(md), [], 'https links must not be parsed as command links');
});

// --- crepair.providerPolicy (D-019 follow-up) --------------------------------

test('crepair.providerPolicy default is "private-cheap" and matches DEFAULT_OVERRIDES', () => {
  const prop = properties['crepair.providerPolicy'];
  assert.ok(prop, 'crepair.providerPolicy is missing from configuration');
  assert.equal(prop!.type, 'string');
  assert.equal(prop!.default, 'private-cheap', 'the default must be private-cheap (recommended)');
  // The package.json default is the single source the bridge falls back to; it must
  // equal the code constant so the two never drift.
  assert.equal(prop!.default, DEFAULT_OVERRIDES.providerPolicy);
});

test('crepair.providerPolicy enum + labels are exactly the two policies', () => {
  const prop = properties['crepair.providerPolicy'];
  assert.deepEqual(prop!.enum, ['private-cheap', 'balanced']);
  assert.deepEqual(prop!.enumItemLabels, [
    'Private & cheapest — ZDR providers only, lowest price first (recommended)',
    'Balanced — OpenRouter default routing',
  ]);
});

test('crepair.providerPolicy description states the custom-mode + empty-order scope', () => {
  const md =
    properties['crepair.providerPolicy']?.markdownDescription ?? '';
  assert.ok(
    md.includes('Custom mode only when Provider Order is empty'),
    'the description must state the custom-mode + empty-order applicability',
  );
  // Verbosity pass 2026-08-24: precedence lives in the Provider Order
  // description; "Preset/Free unaffected" is implied by the scope sentence.
  // What must survive here: the ZDR caveat AND its remedy.
  assert.ok(
    md.includes('Zero Data Retention') && md.includes('may fail'),
    'the description must warn that a model without ZDR endpoints may fail',
  );
  assert.ok(
    md.includes('switch to Balanced'),
    'the description must offer the Balanced fallback as the remedy',
  );
});

test('crepair.providerPolicy is placed directly before crepair.providerOrder', () => {
  // Reading order mirrors the recommended path (user request, 2026-08-24):
  // the automatic policy is the default entry point, the explicit order is the
  // advanced override below it — even though the ORDER wins at runtime.
  const keys = flatKeys();
  const orderIdx = keys.indexOf('crepair.providerOrder');
  const policyIdx = keys.indexOf('crepair.providerPolicy');
  assert.ok(orderIdx !== -1 && policyIdx !== -1, 'both settings must be present');
  assert.equal(orderIdx, policyIdx + 1, 'providerOrder must immediately follow providerPolicy');
});

test('the info panels carry no editable value (harmless as a setting)', () => {
  // "type": "null" renders the title + markdownDescription with no input widget,
  // so the panel cannot store a stray value that alters extension behaviour.
  for (const key of ['crepair.apiKey', 'crepair.commands']) {
    const prop = properties[key] as
      | (PkgProperty & { type?: unknown; default?: unknown })
      | undefined;
    assert.ok(prop, `${key} info panel is missing from configuration`);
    assert.equal(prop!.type, 'null', `${key} should be type "null" to be an inert info panel`);
    assert.equal(prop!.default, null, `${key} should default to null`);
  }
});

// --- section structure (Settings-UI reorganization) --------------------------
//
// `contributes.configuration` is a section ARRAY so the Settings UI groups the
// settings under readable sub-headings. These guards pin the section titles, their
// order, and which setting lives in which section — the KEYS are unchanged, only
// their grouping. A future edit that moves a setting or renames a section fails here.

/** The canonical section layout: title -> keys, in UI order. */
const EXPECTED_SECTIONS: Array<{ title: string; keys: string[] }> = [
  { title: 'Setup', keys: ['crepair.apiKey', 'crepair.commands'] },
  {
    title: 'Models & Routing',
    keys: [
      // All-mode settings first (reasoningEffort applies in every mode), then
      // the Custom-only block (user feedback, 2026-08-24).
      'crepair.modelMode',
      'crepair.freeModel',
      'crepair.reasoningEffort',
      'crepair.model',
      'crepair.providerPolicy',
      'crepair.providerOrder',
      'crepair.allowFallbacks',
    ],
  },
  {
    title: 'Scanning & Context',
    keys: ['crepair.contextReview', 'crepair.compileIncludePaths', 'crepair.autoIncludeFileDir'],
  },
  {
    title: 'Repairs & Reports',
    keys: ['crepair.autoRepairLimit', 'crepair.report.includeRejectedProposals'],
  },
  { title: 'Privacy & Usage', keys: ['crepair.externalRouteNotice', 'crepair.showCosts'] },
  { title: 'Editor Menus', keys: ['crepair.menu.showScan', 'crepair.menu.showScanAndFix'] },
  {
    title: 'Bridge (Advanced)',
    keys: ['crepair.bridge.pythonPath', 'crepair.bridge.configPath', 'crepair.bridge.port'],
  },
];

test('configuration is a section array with the expected titles and order', () => {
  const titles = readSections().map((s) => s.title);
  assert.deepEqual(
    titles,
    EXPECTED_SECTIONS.map((s) => s.title),
    'section titles / order drifted from the canonical layout',
  );
});

test('every section lists exactly its expected settings, in order', () => {
  const sections = readSections();
  for (const expected of EXPECTED_SECTIONS) {
    const section = sections.find((s) => s.title === expected.title);
    assert.ok(section, `section "${expected.title}" is missing`);
    assert.deepEqual(
      Object.keys(section!.properties),
      expected.keys,
      `section "${expected.title}" membership / order drifted`,
    );
  }
});

test('the flattened key set matches the union of the sections (no stray / dropped keys)', () => {
  const expectedAll = EXPECTED_SECTIONS.flatMap((s) => s.keys);
  assert.deepEqual(flatKeys(), expectedAll, 'flattened keys drifted from the section union');
});
