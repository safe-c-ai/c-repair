import type { LocalSettings } from './localSettings';

export interface LocalReasoningInfo { key: string; repair: string; detection: string }
export function reasoningKey(s: LocalSettings): string {
  return JSON.stringify([s.modelPath, s.templatePath, s.preset, s.effort, s.generation, s.detectionGeneration, s.structuredGeneration]);
}

/** Inspect an actually rendered synthetic prompt, never user code or generated CoT.
 * Recognize only explicit markers; arbitrary templates must remain unverified. */
export function renderedReasoning(prompt: string, kwargs: Record<string, unknown>): string {
  const closed = /<think>\s*<\/think>\s*$/.test(prompt);
  const open = /<think>\s*$/.test(prompt);
  const defaultThinking = kwargs.enable_thinking === undefined;
  if (closed) return defaultThinking ? 'off (model default)' : 'off';
  if (!open) return 'unverified';
  const effort = /Reasoning effort is set to (xhigh|high|medium|low)\./.exec(prompt)?.[1];
  if (effort) return `${effort}${kwargs.reasoning_effort === undefined ? ' (model default)' : ''}`;
  return `on${defaultThinking ? ' (model default)' : ''} · effort unverified`;
}

export async function inspectLocalReasoning(port: number, settings: LocalSettings): Promise<LocalReasoningInfo | undefined> {
  if (settings.preset !== 'custom') return undefined;
  async function inspect(options: Record<string, unknown> | undefined): Promise<string> {
    const kwargs = (options?.chat_template_kwargs ?? {}) as Record<string, unknown>;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/apply-template`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply OK.' }], chat_template_kwargs: kwargs }),
      });
      if (!r.ok) return 'unverified';
      const data = await r.json() as { prompt?: unknown };
      return typeof data.prompt === 'string' ? renderedReasoning(data.prompt, kwargs) : 'unverified';
    } catch { return 'unverified'; }
  }
  const repair = await inspect(settings.generation);
  const detection = settings.detectionGeneration?.chat_template_kwargs === undefined ? repair : await inspect({ ...settings.generation, ...settings.detectionGeneration });
  return { key: reasoningKey(settings), repair, detection };
}
