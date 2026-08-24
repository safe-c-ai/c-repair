// Shared helper for reading the extension's `contributes.configuration`.
//
// `contributes.configuration` is an ARRAY of `{ title, properties }` sections (the
// Settings UI renders each as its own sub-heading under "C Repair"). The individual
// setting KEYS are unchanged (D-037/D-039 display/ID separation) — only their grouping
// and order in the UI. Most guards care about the flat key→property map exactly as
// before, so `flatProperties()` splices every section's properties back into one
// object (section order then in-section order preserved). `readSections()` exposes the
// raw section list so a dedicated test can pin the section titles, membership and order.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_PATH = join(__dirname, '..', 'package.json');

export interface PkgProperty {
  markdownDescription?: string;
  markdownEnumDescriptions?: string[];
  enumItemLabels?: unknown;
  type?: unknown;
  default?: unknown;
  enum?: unknown;
}

export interface ConfigSection {
  title: string;
  properties: Record<string, PkgProperty>;
}

/** Parse package.json fresh (tests read it directly, no VS Code host). */
export function readPkg(): { contributes: { configuration: ConfigSection[] } } {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8'));
}

/** The raw `contributes.configuration` section array. */
export function readSections(): ConfigSection[] {
  const cfg = readPkg().contributes.configuration;
  if (!Array.isArray(cfg)) {
    throw new Error('contributes.configuration must be an array of {title, properties} sections');
  }
  return cfg;
}

/**
 * All settings as a single key→property map, flattening every section in declaration
 * order (section order, then in-section order). Mirrors the pre-sectioning shape so the
 * existing flat guards keep working unchanged.
 */
export function flatProperties(): Record<string, PkgProperty> {
  const out: Record<string, PkgProperty> = {};
  for (const section of readSections()) {
    for (const [key, prop] of Object.entries(section.properties)) out[key] = prop;
  }
  return out;
}

/** The setting keys in the flattened declaration order (for order assertions). */
export function flatKeys(): string[] {
  return readSections().flatMap((s) => Object.keys(s.properties));
}
