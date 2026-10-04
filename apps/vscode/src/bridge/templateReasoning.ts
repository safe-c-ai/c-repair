import { readSelectedTemplate } from './ggufTemplate';
import type { LocalSettings } from './localSettings';
export const COMMON_REASONING = ['model', 'max', 'xhigh', 'high', 'medium', 'low', 'on', 'off'] as const;
export interface TemplateReasoning {
  known: boolean;
  values: string[];
  defaultValue?: string;
  aliases: Record<string, string>;
}
const unknown = (): TemplateReasoning => ({ known: false, values: [...COMMON_REASONING], aliases: {} });
/** Conservative recognition of explicit template conventions, not model names.
 * Unfamiliar conditional logic is intentionally left to the fallback picker. */
export function analyzeTemplateReasoning(template: string): TemplateReasoning {
  const t = template.replace(/\{#[\s\S]*?#\}/g, '');
  const tail = t.slice(t.lastIndexOf('{%- if add_generation_prompt %}'));
  if (!/if enable_thinking is defined and enable_thinking is false/.test(tail)
      || !tail.includes("'<think>\\n\\n</think>\\n\\n'") || !tail.includes("'<think>\\n'")) return unknown();
  if (!/\breasoning_effort\b/.test(t)) return { known: true, values: ['model', 'on', 'off'], defaultValue: 'on', aliases: {} };
  const def = /set resolved_reasoning_effort = reasoning_effort\s*\|\s*default\(['"](\w+)['"]\)/.exec(t)?.[1];
  const accepted = /if resolved_reasoning_effort not in \(([^)]+)\)[\s\S]{0,100}raise_exception/.exec(t)?.[1];
  if (!def || !accepted || !/if enable_thinking is undefined or enable_thinking is true/.test(t)) return unknown();
  const values = [...accepted.matchAll(/['"](\w+)['"]/g)].map(m => m[1]);
  if (!values.length || !values.includes(def) || values.some(v => !COMMON_REASONING.includes(v as typeof COMMON_REASONING[number]))) return unknown();
  const aliases: Record<string,string> = {};
  for (const m of t.matchAll(/if resolved_reasoning_effort == ['"](\w+)['"]\s*%\}\s*\{%[-]?\s*set resolved_reasoning_effort = ['"](\w+)['"]/g)) {
    if (values.includes(m[2])) aliases[m[1]] = m[2];
  }
  return { known: true, values: ['model', ...values, 'off'], defaultValue: def, aliases };
}
export async function inspectTemplateReasoning(s: LocalSettings): Promise<TemplateReasoning> {
  try { return analyzeTemplateReasoning(await readSelectedTemplate(s.modelPath, s.templatePath)); }
  catch { return unknown(); }
}
export function selectReasoning(s: LocalSettings, value: string, structured: boolean | 'detection' = false): void {
  const key = structured === 'detection' ? 'detectionGeneration' : structured ? 'structuredGeneration' : 'generation';
  const options = { ...s[key] };
  const kwargs = { ...(options.chat_template_kwargs as Record<string, unknown> ?? {}) };
  delete kwargs.enable_thinking; delete kwargs.reasoning_effort;
  if (value !== 'model') kwargs.enable_thinking = value !== 'off';
  if (!['model','on','off'].includes(value)) kwargs.reasoning_effort = value;
  options.chat_template_kwargs = kwargs;
  s[key] = options;
  // Preserve legacy readers for values their schemas already accept.
  if (!structured && ((s.preset === 'qwen38-27b-q4km' && ['off','medium','xhigh'].includes(value)) || value === 'off')) s.effort = value as LocalSettings['effort'];
}

export function templateReasoningLabel(s: LocalSettings, cap: TemplateReasoning, detection = false): string {
  const options = detection ? { ...s.generation, ...s.detectionGeneration } : s.generation;
  const explicit = options?.chat_template_kwargs as Record<string, unknown> | undefined;
  const kwargs = explicit ?? (s.preset === 'custom' ? {} : { enable_thinking: s.effort !== 'off', ...(s.preset === 'qwen38-27b-q4km' ? { reasoning_effort: s.effort } : {}) });
  if (kwargs.enable_thinking === false) return 'off';
  const effort = kwargs.reasoning_effort;
  if (typeof effort === 'string') {
    const alias = cap.aliases[effort];
    if (alias) return `${effort} → ${alias} (template alias)`;
    return cap.known ? cap.values.includes(effort) ? effort : `${effort} (unsupported)` : `${effort} (unverified)`;
  }
  if (cap.defaultValue) return `${cap.defaultValue} (model default)`;
  return kwargs.enable_thinking === true ? 'on · effort unverified' : 'model default (unverified)';
}
