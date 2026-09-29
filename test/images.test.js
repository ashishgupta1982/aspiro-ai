import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, ImageGenerationError, IMAGE_MODELS } from '../src/images/index.js';

const CREDS = 'kid:secret';

/** A fake fetch that answers each call from a queue and records what was sent. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const r = responses.shift() ?? { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: 'x', json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const queued = { status: 200, body: { status: 'queued', request_id: 'r1', status_url: 'https://api.higgsfield.ai/requests/r1/status', cancel_url: 'https://api.higgsfield.ai/requests/r1/cancel' } };

test('submits to the model path with Key auth, polls, returns the image url', async () => {
  const f = fakeFetch([
    queued,
    { status: 200, body: { status: 'in_progress' } },
    { status: 200, body: { status: 'completed', images: [{ url: 'https://cdn.example/img.png' }] } },
  ]);
  const out = await generateImage({ prompt: 'a pie', credentials: CREDS, fetch: f, pollMs: 1 });
  assert.deepEqual(out, { url: 'https://cdn.example/img.png', requestId: 'r1', model: 'soul-v2' });
  assert.equal(f.calls[0].url, `https://api.higgsfield.ai${IMAGE_MODELS['soul-v2'].path}`);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.Authorization, `Key ${CREDS}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { prompt: 'a pie' });
  assert.equal(f.calls[1].url, 'https://api.higgsfield.ai/requests/r1/status');
});

test('passes extra params through, and prompt always wins', async () => {
  const f = fakeFetch([queued, { status: 200, body: { status: 'completed', images: [{ url: 'u' }] } }]);
  await generateImage({ prompt: 'p', params: { aspect_ratio: '4:3', prompt: 'ignored' }, credentials: CREDS, fetch: f, pollMs: 1 });
  assert.deepEqual(JSON.parse(f.calls[0].body), { aspect_ratio: '4:3', prompt: 'p' });
});

test('a failed or nsfw job throws a rejected error with the request id', async () => {
  for (const status of ['failed', 'nsfw', 'canceled']) {
    const f = fakeFetch([queued, { status: 200, body: { status } }]);
    await assert.rejects(
      generateImage({ prompt: 'p', credentials: CREDS, fetch: f, pollMs: 1 }),
      (e) => e instanceof ImageGenerationError && e.code === 'rejected' && e.status === status && e.requestId === 'r1',
    );
  }
});

test('times out, cancels the job, and says so', async () => {
  const f = fakeFetch([queued, ...Array.from({ length: 50 }, () => ({ status: 200, body: { status: 'in_progress' } }))]);
  await assert.rejects(
    generateImage({ prompt: 'p', credentials: CREDS, fetch: f, pollMs: 1, timeoutMs: 20 }),
    (e) => e.code === 'timeout' && e.requestId === 'r1',
  );
  assert.ok(f.calls.some((c) => c.url.endsWith('/requests/r1/cancel') && c.method === 'POST'));
});

test('missing credentials fail before any request', async () => {
  const f = fakeFetch([]);
  await assert.rejects(generateImage({ prompt: 'p', credentials: '', fetch: f }), (e) => e.code === 'no_credentials');
  assert.equal(f.calls.length, 0);
});

test('an HTTP error surfaces the status and Higgsfield detail', async () => {
  const f = fakeFetch([{ status: 402, body: { detail: 'Not enough credits' } }]);
  await assert.rejects(
    generateImage({ prompt: 'p', credentials: CREDS, fetch: f }),
    (e) => e.code === 'http' && e.status === 402 && /Not enough credits/.test(e.message),
  );
});

test('unknown model and empty prompt are rejected up front', async () => {
  const f = fakeFetch([]);
  await assert.rejects(generateImage({ prompt: 'p', model: 'nope', credentials: CREDS, fetch: f }), /Unknown image model/);
  await assert.rejects(generateImage({ prompt: '  ', credentials: CREDS, fetch: f }), /prompt is required/);
  assert.equal(f.calls.length, 0);
});
