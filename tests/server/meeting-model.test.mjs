import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMeetingJson } from '../../lib/integrations/meeting-model.ts';

function setup(t, fetcher) {
  for (const [key, value] of Object.entries({ MEETING_MODEL_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'test-only', SILICONFLOW_MODEL: 'Qwen/Qwen3.5-4B' })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  t.mock.method(globalThis, 'fetch', fetcher);
}
const response = (content, finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content } }] });

test('meeting model uses selected provider and propagates cancellation with JSON-only output', async t => {
  const controller = new AbortController();
  setup(t, async (url, init) => {
    assert.equal(url, 'https://api.siliconflow.cn/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'Qwen/Qwen3.5-4B');
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].content, '中文测试');
    controller.abort(); assert.equal(init.signal.aborted, true);
    return response('{"nodeUpserts":[]}');
  });
  assert.deepEqual(await generateMeetingJson('中文测试', { signal: controller.signal }), { nodeUpserts: [] });
});

test('provider failures are redacted and never silently fall back', async t => {
  let calls = 0;
  setup(t, async () => { calls++; return new Response('private prompt and secret', { status: 429 }); });
  await assert.rejects(generateMeetingJson('private'), { message: 'SiliconFlow request failed (HTTP 429).' });
  assert.equal(calls, 1);
});

test('rejects truncated, missing and malformed model output before node writes', async t => {
  const responses = [response('{}', 'length'), response(null), response('not JSON')];
  setup(t, async () => responses.shift());
  for (const message of ['incomplete content', 'empty content', 'invalid JSON content']) {
    await assert.rejects(generateMeetingJson('test'), new RegExp(message));
  }
});

test('unknown providers fail before sending data anywhere', async t => {
  setup(t, async () => { assert.fail('unexpected provider request'); });
  process.env.MEETING_MODEL_PROVIDER = 'typo';
  await assert.rejects(generateMeetingJson('test'), /Unknown meeting model provider/);
});
