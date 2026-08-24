// Pure builder for the "View Model Providers" link (crepair.openModelProviders).
// Given the effective model id, produces the OpenRouter model page URL where the
// providers serving that model are listed. Kept free of the `vscode` module so it
// is unit testable under plain Node (mirrors bridge/health.ts, bridge/overrideEnv.ts).
//
// URL format (verified against openrouter.ai): a model page lives at
//   https://openrouter.ai/<author>/<slug>
// and the `:free` suffix is part of the slug and is kept verbatim, e.g.
//   https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free
// So the effective model id maps directly onto the path with no transformation
// beyond trimming and URL-safe encoding of each path segment.

import { DEFAULT_OVERRIDES } from '../bridge/overrideEnv';

/** The OpenRouter site root the model page hangs off. */
export const OPENROUTER_BASE = 'https://openrouter.ai';

/**
 * The effective model id used for the providers link: the configured
 * `crepair.model` when non-blank, otherwise the verified default. Trimmed. This is
 * a pure resolution of "which model does an empty setting mean" — the same default
 * the bridge falls back to (DEFAULT_OVERRIDES.model).
 */
export function effectiveModelId(configuredModel: string | undefined): string {
  const m = (configuredModel ?? '').trim();
  return m.length > 0 ? m : DEFAULT_OVERRIDES.model;
}

/**
 * Build the OpenRouter model page URL for a model id. Each `/`-separated path
 * segment is percent-encoded so an unusual id cannot break the URL, but `:` (the
 * `:free` variant marker) is preserved because OpenRouter's model page path uses
 * it literally. An empty/whitespace id resolves to the verified default first.
 */
export function modelProvidersUrl(configuredModel: string | undefined): string {
  const id = effectiveModelId(configuredModel);
  const path = id
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `${OPENROUTER_BASE}/${path}`;
}
