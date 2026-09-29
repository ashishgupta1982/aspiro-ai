import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submitImage, submitRequest, uploadInput, getImageStatus, generateImage, readResult, isFinished, isFailed, ImageGenerationError, IMAGE_MODELS,
} from '../src/images/index.js';

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

const queued = { status: 200, body: { status: 'queued', request_id: 'r1' } };
const done = { status: 200, body: { status: 'completed', images: [{ url: 'https://cdn.example/img.png' }] } };

test('submitImage posts to the model path with Key auth and returns the request id', async () => {
  const f = fakeFetch([queued]);
  const out = await submitImage({ prompt: 'a pie', credentials: CREDS, fetch: f });
  assert.deepEqual(out, { requestId: 'r1', status: 'queued', model: 'soul-v2' });
  assert.equal(f.calls[0].url, `https://api.higgsfield.ai${IMAGE_MODELS['soul-v2'].path}`);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.Authorization, `Key ${CREDS}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { prompt: 'a pie' });
});

test('submitImage adds hf_webhook, url-encoded, when given', async () => {
  const f = fakeFetch([queued]);
  await submitImage({ prompt: 'p', webhookUrl: 'https://app.example/api/hook?token=a b', credentials: CREDS, fetch: f });
  assert.ok(f.calls[0].url.endsWith('?hf_webhook=https%3A%2F%2Fapp.example%2Fapi%2Fhook%3Ftoken%3Da%20b'));
});

test('params pass through, and prompt always wins', async () => {
  const f = fakeFetch([queued]);
  await submitImage({ prompt: 'p', params: { aspect_ratio: '4:3', prompt: 'ignored' }, credentials: CREDS, fetch: f });
  assert.deepEqual(JSON.parse(f.calls[0].body), { aspect_ratio: '4:3', prompt: 'p' });
});

test('a full concurrency slot is "busy", not a failure', async () => {
  const f = fakeFetch([{ status: 400, body: { detail: 'Maximum number of concurrent requests (2) has been reached' } }]);
  await assert.rejects(submitImage({ prompt: 'p', credentials: CREDS, fetch: f }), (e) => e instanceof ImageGenerationError && e.code === 'busy');
});

test('other HTTP errors keep the status and Higgsfield detail', async () => {
  const f = fakeFetch([{ status: 402, body: { detail: 'Not enough credits' } }]);
  await assert.rejects(submitImage({ prompt: 'p', credentials: CREDS, fetch: f }), (e) => e.code === 'http' && e.status === 402 && /Not enough credits/.test(e.message));
});

test('getImageStatus reads status and the image url; 404 is not_found', async () => {
  const f = fakeFetch([done, { status: 200, body: { status: 'in_progress' } }, { status: 404, body: { detail: 'Not found' } }]);
  assert.deepEqual(await getImageStatus('r1', { credentials: CREDS, fetch: f }), { status: 'completed', url: 'https://cdn.example/img.png', kind: 'image', error: null });
  assert.equal(f.calls[0].url, 'https://api.higgsfield.ai/requests/r1/status');
  assert.equal((await getImageStatus('r1', { credentials: CREDS, fetch: f })).status, 'in_progress');
  await assert.rejects(getImageStatus('r1', { credentials: CREDS, fetch: f }), (e) => e.code === 'not_found');
});

test('readResult understands a webhook body too', () => {
  assert.deepEqual(readResult({ request_id: 'r1', status: 'completed', error: null, payload: { images: [{ url: 'u' }] } }), { status: 'completed', url: 'u', kind: 'image', error: null });
  assert.deepEqual(readResult({ status: 'nsfw', error: 'blocked', payload: null }), { status: 'nsfw', url: null, kind: null, error: 'blocked' });
});

test('readResult reads a video (status check or webhook)', () => {
  assert.deepEqual(readResult({ status: 'completed', video: { url: 'v.mp4' } }), { status: 'completed', url: 'v.mp4', kind: 'video', error: null });
  assert.deepEqual(readResult({ status: 'completed', payload: { video: { url: 'w.mp4' } } }), { status: 'completed', url: 'w.mp4', kind: 'video', error: null });
});

test('isFinished / isFailed', () => {
  assert.ok(isFinished('completed') && isFinished('nsfw') && !isFinished('in_progress') && !isFinished('queued'));
  assert.ok(isFailed('failed') && isFailed('nsfw') && !isFailed('completed'));
});

test('generateImage waits for completion', async () => {
  const f = fakeFetch([queued, { status: 200, body: { status: 'in_progress' } }, done]);
  const out = await generateImage({ prompt: 'p', credentials: CREDS, fetch: f, pollMs: 1 });
  assert.deepEqual(out, { url: 'https://cdn.example/img.png', requestId: 'r1', model: 'soul-v2' });
});

test('generateImage times out WITHOUT cancelling, and hands back the id', async () => {
  const f = fakeFetch([queued, ...Array.from({ length: 50 }, () => ({ status: 200, body: { status: 'in_progress' } }))]);
  await assert.rejects(
    generateImage({ prompt: 'p', credentials: CREDS, fetch: f, pollMs: 1, timeoutMs: 20 }),
    (e) => e.code === 'timeout' && e.requestId === 'r1',
  );
  assert.ok(!f.calls.some((c) => /cancel/.test(c.url)));
});

test('a failed or nsfw job is rejected with its status', async () => {
  for (const status of ['failed', 'nsfw']) {
    const f = fakeFetch([queued, { status: 200, body: { status } }]);
    await assert.rejects(generateImage({ prompt: 'p', credentials: CREDS, fetch: f, pollMs: 1 }), (e) => e.code === 'rejected' && e.status === status);
  }
});

test('missing credentials, unknown model and empty prompt fail before any request', async () => {
  const f = fakeFetch([]);
  await assert.rejects(submitImage({ prompt: 'p', credentials: '', fetch: f }), (e) => e.code === 'no_credentials');
  await assert.rejects(submitImage({ prompt: 'p', model: 'nope', credentials: CREDS, fetch: f }), /Unknown image model/);
  await assert.rejects(submitImage({ prompt: '  ', credentials: CREDS, fetch: f }), /prompt is required/);
  assert.equal(f.calls.length, 0);
});

test('submitRequest posts any body to any model path', async () => {
  const f = fakeFetch([queued]);
  const out = await submitRequest({ path: 'kling-video/v3.0/pro/image-to-video', body: { prompt: 'p', image_url: 'u', duration: 5 }, credentials: CREDS, fetch: f });
  assert.deepEqual(out, { requestId: 'r1', status: 'queued' });
  assert.equal(f.calls[0].url, 'https://api.higgsfield.ai/kling-video/v3.0/pro/image-to-video');
  assert.deepEqual(JSON.parse(f.calls[0].body), { prompt: 'p', image_url: 'u', duration: 5 });
  await assert.rejects(submitRequest({ body: {}, credentials: CREDS, fetch: f }), /model path is required/);
});

test('uploadInput asks for an upload URL, PUTs the bytes, returns the public URL', async () => {
  const f = fakeFetch([
    { status: 200, body: { upload_url: 'https://s3.example/put', public_url: 'https://cdn.example/in.png', upload_headers: { 'x-amz-tagging': 'retention=temporary' } } },
    { status: 200, body: null },
  ]);
  const out = await uploadInput(Buffer.from('png'), 'image/png', { credentials: CREDS, fetch: f });
  assert.deepEqual(out, { url: 'https://cdn.example/in.png' });
  assert.equal(f.calls[0].url, 'https://api.higgsfield.ai/files/generate-upload-url');
  assert.deepEqual(JSON.parse(f.calls[0].body), { content_type: 'image/png' });
  assert.equal(f.calls[1].url, 'https://s3.example/put');
  assert.equal(f.calls[1].method, 'PUT');
  assert.equal(f.calls[1].headers['x-amz-tagging'], 'retention=temporary');
});

test('uploadInput surfaces a failed PUT', async () => {
  const f = fakeFetch([{ status: 200, body: { upload_url: 'https://s3.example/put', public_url: 'p' } }, { status: 403, body: null }]);
  await assert.rejects(uploadInput(Buffer.from('x'), 'image/png', { credentials: CREDS, fetch: f }), (e) => e.code === 'http' && e.status === 403);
});
