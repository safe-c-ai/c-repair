// Barrel export for @c-repair/core.
export {
  applyHunks,
  hunkRange,
  rangesIntersect,
  candidatesConflict,
} from './patches.js';
export {
  MARKER_START,
  MARKER_END,
  PRELUDE_NOTE,
  synthesizePrelude,
  synthesizedPreludeLineCount,
  composeAugmentedC,
} from './prelude.js';
