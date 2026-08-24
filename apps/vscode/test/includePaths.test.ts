// Unit tests for the pure compile-include-path assembly (D-020). Pure Node, no
// `vscode` module. Load-bearing: a non-file document adds no auto dir; the auto
// dir comes first; the configured paths are appended, trimmed and de-duplicated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompileIncludePaths,
  DEFAULT_INCLUDE_PATH_SETTINGS,
  type IncludePathSettings,
} from '../src/session/includePaths';

function settings(overrides: Partial<IncludePathSettings> = {}): IncludePathSettings {
  return {
    ...DEFAULT_INCLUDE_PATH_SETTINGS,
    compileIncludePaths: [...DEFAULT_INCLUDE_PATH_SETTINGS.compileIncludePaths],
    ...overrides,
  };
}

test('default settings on a non-file document produce an empty list', () => {
  assert.deepEqual(buildCompileIncludePaths(settings(), undefined), []);
});

test('auto file dir is included first when enabled and a file dir is present', () => {
  assert.deepEqual(buildCompileIncludePaths(settings(), '/proj/src'), ['/proj/src']);
});

test('auto file dir is NOT included when the source is not a file (undefined dir)', () => {
  assert.deepEqual(
    buildCompileIncludePaths(settings({ compileIncludePaths: ['/proj/include'] }), undefined),
    ['/proj/include'],
  );
});

test('auto file dir off drops the file dir even when present', () => {
  assert.deepEqual(
    buildCompileIncludePaths(
      settings({ autoIncludeFileDir: false, compileIncludePaths: ['/proj/include'] }),
      '/proj/src',
    ),
    ['/proj/include'],
  );
});

test('auto dir first, then configured paths, order preserved', () => {
  assert.deepEqual(
    buildCompileIncludePaths(
      settings({ compileIncludePaths: ['/proj/include', '/proj/vendor'] }),
      '/proj/src',
    ),
    ['/proj/src', '/proj/include', '/proj/vendor'],
  );
});

test('configured path equal to the auto dir is de-duplicated (auto wins its slot)', () => {
  assert.deepEqual(
    buildCompileIncludePaths(
      settings({ compileIncludePaths: ['/proj/src', '/proj/include'] }),
      '/proj/src',
    ),
    ['/proj/src', '/proj/include'],
  );
});

test('blank and whitespace-only configured entries are dropped', () => {
  assert.deepEqual(
    buildCompileIncludePaths(
      settings({ compileIncludePaths: ['', '  ', ' /proj/include '] }),
      undefined,
    ),
    ['/proj/include'],
  );
});

test('duplicate configured paths are de-duplicated, first-seen order kept', () => {
  assert.deepEqual(
    buildCompileIncludePaths(
      settings({ compileIncludePaths: ['/a', '/b', '/a', '/c', '/b'] }),
      undefined,
    ),
    ['/a', '/b', '/c'],
  );
});

test('all-default with a file dir yields just the file dir (the common case)', () => {
  assert.deepEqual(buildCompileIncludePaths(settings(), '/home/u/project'), [
    '/home/u/project',
  ]);
});
