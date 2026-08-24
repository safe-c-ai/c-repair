// Unit tests for the size-scaled bridge timeouts (task B) + the large-file warning
// threshold (task C). Pure Node, no `vscode` and no network: every function under
// test is a pure numeric formula. Load-bearing properties: small files stay at the
// 300s / 180s base, large files scale up, both clamp at their ceilings, and the
// large-file predicate flips at ~12k estimated output tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimatedOutputTokens,
  repairTimeoutMs,
  scanTimeoutMs,
  isLargeRepair,
  LARGE_FILE_OUTPUT_TOKENS,
} from '../src/bridge/repairTimeout';

// --- estimatedOutputTokens: chars -> tokens with growth + fixed allowance ----

test('estimatedOutputTokens is the fixed allowance at zero chars', () => {
  // 0/3.5*1.3 + 4096 = 4096.
  assert.equal(estimatedOutputTokens(0), 4096);
});

test('estimatedOutputTokens grows with size', () => {
  const small = estimatedOutputTokens(1000);
  const big = estimatedOutputTokens(100_000);
  assert.ok(big > small);
  // 100000/3.5*1.3 + 4096 ≈ 37142.9 + 4096 ≈ 41238.9.
  assert.ok(Math.abs(estimatedOutputTokens(100_000) - 41238.86) < 1);
});

test('estimatedOutputTokens treats negative chars as zero', () => {
  assert.equal(estimatedOutputTokens(-5), 4096);
});

// --- repairTimeoutMs: 300s base, scales, 1800s ceiling -----------------------

test('repairTimeoutMs stays at the 300s base for small files', () => {
  // A tiny file's modeled generation is far under 300s -> clamped up to the base.
  assert.equal(repairTimeoutMs(0), 300_000);
  assert.equal(repairTimeoutMs(500), 300_000);
});

test('repairTimeoutMs scales above the base for a mid-size file', () => {
  // ~50k chars: tokens ≈ 50000/3.5*1.3 + 4096 ≈ 22667; /40*1.5 ≈ 850s -> above the
  // 300s base and below the 1800s ceiling.
  const ms = repairTimeoutMs(50_000);
  assert.ok(ms > 300_000, `expected > base, got ${ms}`);
  assert.ok(ms < 1_800_000, `expected < ceiling, got ${ms}`);
});

test('repairTimeoutMs clamps at the 1800s (30min) ceiling for a huge file', () => {
  assert.equal(repairTimeoutMs(5_000_000), 1_800_000);
});

test('repairTimeoutMs is monotonic non-decreasing in size', () => {
  const sizes = [0, 1_000, 50_000, 200_000, 1_000_000, 5_000_000];
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(
      repairTimeoutMs(sizes[i]) >= repairTimeoutMs(sizes[i - 1]),
      `not monotonic at ${sizes[i]}`,
    );
  }
});

// --- scanTimeoutMs: 180s base, gentler scale, 900s ceiling -------------------

test('scanTimeoutMs is the 180s base at zero and only just above it for small files', () => {
  // Scan is base + size-factor (not clamp-up like repair), so it equals the base at
  // zero chars and rises only marginally for a small file.
  assert.equal(scanTimeoutMs(0), 180_000);
  const small = scanTimeoutMs(1_000);
  assert.ok(small >= 180_000 && small < 190_000, `expected ~base, got ${small}`);
});

test('scanTimeoutMs scales above the base for a large file', () => {
  const ms = scanTimeoutMs(1_000_000);
  assert.ok(ms > 180_000, `expected > base, got ${ms}`);
  assert.ok(ms <= 900_000, `expected <= ceiling, got ${ms}`);
});

test('scanTimeoutMs clamps at the 900s (15min) ceiling for a huge file', () => {
  assert.equal(scanTimeoutMs(50_000_000), 900_000);
});

test('scanTimeoutMs scales more gently than repairTimeoutMs at the same size', () => {
  // Scanning is detection-bound, not whole-file generation, so for a size where
  // both have left their base, scan must be the smaller timeout.
  const size = 2_000_000;
  assert.ok(scanTimeoutMs(size) < repairTimeoutMs(size));
});

// --- isLargeRepair: the task-C warning threshold -----------------------------

test('isLargeRepair is false for a small file', () => {
  assert.equal(isLargeRepair(0), false);
  assert.equal(isLargeRepair(1_000), false);
});

test('isLargeRepair flips true once estimated output exceeds the threshold', () => {
  // Find the char count whose estimate is exactly the threshold, then straddle it.
  // estimate = chars/3.5*1.3 + 4096 > 12000  =>  chars > (12000-4096)*3.5/1.3.
  const boundaryChars = ((LARGE_FILE_OUTPUT_TOKENS - 4096) * 3.5) / 1.3;
  assert.equal(isLargeRepair(Math.floor(boundaryChars) - 100), false);
  assert.equal(isLargeRepair(Math.ceil(boundaryChars) + 100), true);
});

test('isLargeRepair agrees with estimatedOutputTokens at the threshold', () => {
  const chars = 40_000; // estimate ≈ 40000/3.5*1.3 + 4096 ≈ 18953 > 12000
  assert.equal(estimatedOutputTokens(chars) > LARGE_FILE_OUTPUT_TOKENS, isLargeRepair(chars));
});
