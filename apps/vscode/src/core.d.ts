// Type declarations for the shared pure-JS core (@c-repair/core). The runtime
// implementation lives in packages/core/src/*.js and must remain plain ESM JS
// (no TypeScript build), so the extension declares its typed surface here. Kept
// in sync with apps/web/src/core.d.ts and packages/core/src/index.js.

declare module '@c-repair/core' {
  import type { Hunk } from '@c-repair/contract';

  export interface HunkRange {
    start: number;
    end: number;
    insert: boolean;
  }

  export function applyHunks(content: string, hunks: Hunk[]): string;
  export function hunkRange(h: Hunk): HunkRange;
  export function rangesIntersect(a: HunkRange, b: HunkRange): boolean;
  export function candidatesConflict(
    cA: { hunks: Hunk[] },
    cB: { hunks: Hunk[] },
  ): boolean;

  export const MARKER_START: string;
  export const MARKER_END: string;
  export const PRELUDE_NOTE: string;
  export function synthesizePrelude(items: { current_text: string }[]): string;
  export function synthesizedPreludeLineCount(
    items: { current_text: string }[],
  ): number;
  export function composeAugmentedC(
    items: { current_text: string }[],
    originalContent: string,
  ): string;
}
