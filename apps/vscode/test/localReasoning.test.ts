import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inspectLocalReasoning, reasoningKey, renderedReasoning } from '../src/bridge/localReasoning';
import { localThinkingText } from '../src/ui/headerMessage';
import { LOCAL_PRESET, type LocalSettings } from '../src/bridge/localSettings';
const settings: LocalSettings = { ...LOCAL_PRESET, preset: 'custom', effort: 'model', modelPath: '/model.gguf', serverPath: '/engine', generation: {}, structuredGeneration: {} };
const xhigh = 'Reasoning effort is set to xhigh.\n<|im_start|>assistant\n<think>\n';

test('rendered defaults identify xhigh, disabled thinking and unknown effort distinctly', () => {
  assert.equal(renderedReasoning(xhigh, {}), 'xhigh (model default)');
  assert.equal(renderedReasoning(xhigh, { reasoning_effort: 'xhigh' }), 'xhigh');
  assert.equal(renderedReasoning('<think>\n\n</think>\n', {}), 'off (model default)');
  assert.equal(renderedReasoning('<think>\n', {}), 'on (model default) · effort unverified');
  assert.equal(renderedReasoning('unknown template', {}), 'unverified');
});

test('only matching settings use observed defaults; explicit settings take priority', () => {
  const resolved = { key: reasoningKey(settings), repair: 'xhigh (model default)', detection: 'xhigh (model default)' };
  assert.equal(localThinkingText(settings, false, resolved), resolved.repair);
  assert.equal(localThinkingText({ ...settings, modelPath: '/other.gguf' }, false, resolved), 'model default (unverified)');
  assert.equal(localThinkingText({ ...settings, templatePath: '/other.jinja' }, false, resolved), 'model default (unverified)');
  const explicit = { ...settings, generation: { chat_template_kwargs: { enable_thinking: false } } };
  assert.equal(localThinkingText(explicit, false, { ...resolved, key: reasoningKey(explicit) }), 'off');
});

test('runtime inspection renders shared repair/detection options without requesting inference', async () => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/apply-template');
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); requests.push(data);
    assert.deepEqual(data.messages, [{ role: 'user', content: 'Reply OK.' }]);
    res.end(JSON.stringify({ prompt: data.chat_template_kwargs.enable_thinking === false ? '<think>\n</think>\n' : xhigh }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const s = { ...settings, structuredGeneration: { chat_template_kwargs: { enable_thinking: false } } };
    assert.deepEqual(await inspectLocalReasoning(port, s), { key: reasoningKey(s), repair: 'xhigh (model default)', detection: 'xhigh (model default)' });
    assert.equal(requests.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('unavailable inspection remains unverified and does not prevent startup', async () => {
  const result = await inspectLocalReasoning(1, settings);
  assert.equal(result?.repair, 'unverified');
  assert.equal(result?.detection, 'unverified');
});
