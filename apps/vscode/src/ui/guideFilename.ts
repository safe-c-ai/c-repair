export type GuideKind = 'user' | 'local';

/** Pick a bundled guide using VS Code's display language. */
export function guideFilename(kind: GuideKind, language: string): string {
  const base = kind === 'user' ? 'user-guide' : 'local-models';
  const normalized = language.toLowerCase();
  const japanese = normalized === 'ja' || normalized.startsWith('ja-');
  return `${base}${japanese ? '.ja' : ''}.md`;
}
