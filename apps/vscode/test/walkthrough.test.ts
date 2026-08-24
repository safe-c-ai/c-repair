// Walkthrough contribution tests (V3c, V3_PACKAGING_DESIGN §2): the Getting
// Started walkthrough must keep its pinned shape — 5 steps in onboarding order,
// each backed by an existing media markdown file and completed by real
// commands. Pure Node: reads package.json and the media files off disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, '..');

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media: { markdown: string };
  completionEvents: string[];
}

function loadWalkthrough(): { id: string; steps: WalkthroughStep[]; pkg: Record<string, unknown> } {
  const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf8'));
  const walkthroughs = pkg.contributes?.walkthroughs;
  assert.ok(Array.isArray(walkthroughs) && walkthroughs.length === 1, 'exactly one walkthrough');
  return { id: walkthroughs[0].id, steps: walkthroughs[0].steps, pkg };
}

test('the walkthrough has the pinned id and the 5 onboarding steps in order', () => {
  const { id, steps } = loadWalkthrough();
  assert.equal(id, 'crepair.gettingStarted');
  assert.deepEqual(
    steps.map((s) => s.id),
    [
      'crepair.step.apiKey',
      'crepair.step.modelMode',
      'crepair.step.bridge',
      'crepair.step.firstScan',
      'crepair.step.reviewAccept',
    ],
  );
});

test('every step has an existing media markdown file', () => {
  const { steps } = loadWalkthrough();
  for (const step of steps) {
    assert.ok(step.media?.markdown, `${step.id} has a markdown media`);
    const mediaPath = join(EXT_DIR, step.media.markdown);
    assert.ok(existsSync(mediaPath), `${step.media.markdown} exists`);
    // The media must be non-trivial (a heading at minimum).
    assert.match(readFileSync(mediaPath, 'utf8'), /^## /m);
  }
});

test('every completionEvent references a command the extension contributes', () => {
  const { steps, pkg } = loadWalkthrough();
  const contributes = pkg.contributes as { commands: { command: string }[] };
  const known = new Set(contributes.commands.map((c) => c.command));
  for (const step of steps) {
    assert.ok(step.completionEvents.length >= 1, `${step.id} has completionEvents`);
    for (const ev of step.completionEvents) {
      const m = /^onCommand:(.+)$/.exec(ev);
      assert.ok(m, `${step.id}: completionEvent ${ev} is onCommand-based`);
      assert.ok(known.has(m[1]), `${step.id}: command ${m[1]} is contributed`);
    }
  }
});

test('step descriptions link the commands they teach (command: links)', () => {
  const { steps } = loadWalkthrough();
  for (const step of steps) {
    assert.match(step.description, /command:crepair\./, `${step.id} links a command`);
  }
});

/** Read a step's media markdown text by step id (fails if the step is absent). */
function stepMarkdown(stepId: string): string {
  const { steps } = loadWalkthrough();
  const step = steps.find((s) => s.id === stepId);
  assert.ok(step, `${stepId} step exists`);
  return readFileSync(join(EXT_DIR, step!.media.markdown), 'utf8');
}

test('review-accept walkthrough documents wider-change repairs (workflow doc)', () => {
  const md = stepMarkdown('crepair.step.reviewAccept');
  // The new section heading (checked like the walkthrough shape tests: a heading exists).
  assert.match(md, /^### When a repair needs wider changes$/m, 'the wider-changes section heading');
  // Its load-bearing content: starting point, the STR31-C capacity-unknown example,
  // the Accept -> edit -> re-scan loop, and why editing marks results stale.
  assert.match(md, /starting point/);
  assert.match(md, /STR31-C/);
  assert.match(md, /Accept → edit → re-scan/);
  assert.match(md, /stale/);
});
