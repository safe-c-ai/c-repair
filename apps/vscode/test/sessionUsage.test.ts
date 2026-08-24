// Unit tests for the D-030 session token/cost line helpers. Pure Node, no `vscode`
// and no network: every function under test is a pure formatter / predicate. The
// load-bearing properties: k-notation with one decimal, the reasoning segment is
// omitted at zero, the cost segment appears only for a finite non-negative cost, a
// missing usage reading yields no header (tracker disabled -> no display), and the
// poll runs only while an operation is in flight.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTokens,
  formatSessionUsage,
  sessionUsageMessage,
  shouldPollUsage,
  type SessionUsage,
} from '../src/cost/sessionUsage';

const usage = (
  prompt: number,
  completion: number,
  reasoning: number,
  requests = 1,
): SessionUsage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  reasoning_tokens: reasoning,
  requests,
});

// --- formatTokens: k notation, one decimal ---------------------------------

test('formatTokens shows sub-1000 counts verbatim (no decimal)', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(5), '5');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(999), '999');
});

test('formatTokens uses k notation with one decimal at / above 1000', () => {
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(18234), '18.2k');
  assert.equal(formatTokens(5100), '5.1k');
  assert.equal(formatTokens(2100), '2.1k');
  assert.equal(formatTokens(2160), '2.2k'); // rounds to one decimal
});

test('formatTokens treats negative / non-finite as 0 (defensive)', () => {
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), '0');
});

// --- formatSessionUsage: line assembly -------------------------------------

test('formatSessionUsage renders the canonical line with cost', () => {
  assert.equal(
    formatSessionUsage(usage(18234, 5100, 2100), 0.0134),
    'Session: 18.2k in / 5.1k out (reasoning 2.1k) · ≈$0.0134',
  );
});

test('formatSessionUsage omits the reasoning segment when reasoning is zero', () => {
  assert.equal(
    formatSessionUsage(usage(18234, 5100, 0), 0.0134),
    'Session: 18.2k in / 5.1k out · ≈$0.0134',
  );
});

test('formatSessionUsage omits the cost segment when cost is null / undefined', () => {
  assert.equal(
    formatSessionUsage(usage(18234, 5100, 2100), null),
    'Session: 18.2k in / 5.1k out (reasoning 2.1k)',
  );
  assert.equal(
    formatSessionUsage(usage(1500, 300, 0)),
    'Session: 1.5k in / 300 out',
  );
});

test('formatSessionUsage shows a zero-token line (session just started)', () => {
  assert.equal(formatSessionUsage(usage(0, 0, 0, 0)), 'Session: 0 in / 0 out');
});

test('formatSessionUsage includes a zero cost (≈$0.0000) when cost is 0, not null', () => {
  assert.equal(
    formatSessionUsage(usage(1000, 0, 0), 0),
    'Session: 1.0k in / 0 out · ≈$0.0000',
  );
});

test('formatSessionUsage omits the cost segment for a non-finite / negative cost', () => {
  assert.equal(formatSessionUsage(usage(1000, 0, 0), Number.NaN), 'Session: 1.0k in / 0 out');
  assert.equal(formatSessionUsage(usage(1000, 0, 0), -1), 'Session: 1.0k in / 0 out');
});

// --- sessionUsageMessage: header string or none ----------------------------

test('sessionUsageMessage returns undefined when usage is unavailable (tracker off)', () => {
  assert.equal(sessionUsageMessage(null), undefined);
  assert.equal(sessionUsageMessage(undefined, 0.01), undefined);
});

test('sessionUsageMessage renders a line for a valid reading, even at zero', () => {
  assert.equal(sessionUsageMessage(usage(0, 0, 0, 0)), 'Session: 0 in / 0 out');
  assert.equal(
    sessionUsageMessage(usage(1500, 300, 0), 0.002),
    'Session: 1.5k in / 300 out · ≈$0.0020',
  );
});

// --- shouldPollUsage: run only while an operation is in flight -------------

test('shouldPollUsage is true only when at least one operation is in flight', () => {
  assert.equal(shouldPollUsage(1), true);
  assert.equal(shouldPollUsage(3), true);
  assert.equal(shouldPollUsage(0), false);
  assert.equal(shouldPollUsage(-1), false);
});
