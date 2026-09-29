import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from './models.js';

/**
 * Higgsfield image generation over its HTTP API (https://docs.higgsfield.ai).
 *
 * **The API is a queue, so don't wait on it.** A submit returns a
 * `request_id`; the job finishes when Higgsfield gets to it — ~55s for Soul
 * when quiet, several minutes when not. Facts from the docs (2026-09-29) that
 * shape everything here:
 *
 * - **Concurrency counts queued AND processing jobs** (2 on the Aspiro
 *   account). Going over is a 400 "Maximum number of concurrent requests" —
 *   surfaced as `code: 'busy'`, which a caller should treat as "wait", never
 *   as a failure.
 * - **Only a *queued* job can be cancelled.** A processing job runs to the end,
 *   holds its slot, and is **charged when it completes**. So nothing here
 *   cancels on a timeout: that freed nothing and paid for images thrown away.
 * - **Charged on success only**; `failed` / `nsfw` are free. Outputs are kept
 *   at least seven days, so copy what you keep.
 * - **Webhooks:** pass `webhookUrl` and Higgsfield POSTs
 *   `{ request_id, status, error, payload }` on completion, retrying 5xx for two
 *   hours. Deliveries can repeat — dedupe on `request_id` + status.
 *
 * The reliable shape is `submitImage` → store the id → collect via webhook or
 * `getImageStatus` later. `generateImage` is the blocking convenience for
 * scripts and one-offs.
 *
 * Every function returns URLs, never bytes: fetching is the app's job, behind
 * its own SSRF guard. Server-side only — it needs the API key.
 */
const BASE = 'https://api.higgsfield.ai';
const FAILED = new Set(['failed', 'nsfw', 'canceled', 'cancelled']);

export class ImageGenerationError extends Error {
  constructor(message, { status, requestId, code } = {}) {
    super(message);
    this.name = 'ImageGenerationError';
    this.status = status; // Higgsfield's job status, or the HTTP status
    this.requestId = requestId;
    // 'no_credentials' | 'busy' | 'http' | 'rejected' | 'timeout' | 'bad_response' | 'not_found'
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client({ credentials = process.env.HF_CREDENTIALS, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!credentials || !String(credentials).includes(':')) {
    throw new ImageGenerationError('HF_CREDENTIALS is not set (expected "<key id>:<key secret>")', { code: 'no_credentials' });
  }
  const headers = { Authorization: `Key ${credentials}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  return async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const raw = body?.detail || body?.error || body?.message || res.statusText;
      const detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const code = res.status === 404 ? 'not_found'
        : res.status === 400 && /concurrent/i.test(detail) ? 'busy'
        : 'http';
      throw new ImageGenerationError(`Higgsfield ${res.status}: ${detail}`, { status: res.status, code });
    }
    return body || {};
  };
}

/**
 * Normalise a status or webhook body into `{ status, url, kind, error }`.
 * Images come back as `images[0].url`, video as `video.url`, audio as
 * `audio.url` — at the top level on a status check, under `payload` on a
 * webhook.
 */
export function readResult(body = {}) {
  const src = body.payload || body;
  const image = (src.images || body.images || [])[0]?.url;
  const video = src.video?.url || body.video?.url;
  const audio = src.audio?.url || body.audio?.url;
  const url = image || video || audio || null;
  const kind = image ? 'image' : video ? 'video' : audio ? 'audio' : null;
  return { status: body.status, url, kind, error: body.error || null };
}

/**
 * Submit to any model path (image, video, audio) — the generic form of
 * submitImage, for callers that keep their own registry of paths and fields
 * (Command Center's Higgsfield tab). `body` is sent as-is.
 */
export async function submitRequest({ path, body = {}, webhookUrl, credentials, fetch } = {}) {
  if (!path || typeof path !== 'string') throw new ImageGenerationError('A model path is required', { code: 'bad_response' });
  const call = client({ credentials, fetch });
  const clean = path.startsWith('/') ? path : `/${path}`;
  const qs = webhookUrl ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : '';
  const res = await call(`${BASE}${clean}${qs}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.request_id) throw new ImageGenerationError('Higgsfield returned no request_id', { code: 'bad_response' });
  return { requestId: res.request_id, status: res.status };
}

/**
 * Upload an input file (a start frame, a reference) and get the public URL to
 * pass as `image_url` / `video_url` / `audio_url`. Two steps, per the docs:
 * ask for a signed upload URL, then PUT the bytes with the headers it returns.
 * The upload URL lasts an hour; the file is kept on temporary retention.
 */
export async function uploadInput(buffer, contentType, { credentials, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!buffer?.length) throw new ImageGenerationError('Nothing to upload', { code: 'bad_response' });
  if (!contentType) throw new ImageGenerationError('A content type is required', { code: 'bad_response' });
  const call = client({ credentials, fetch: fetchImpl });
  const slot = await call(`${BASE}/files/generate-upload-url`, { method: 'POST', body: JSON.stringify({ content_type: contentType }) });
  if (!slot.upload_url || !slot.public_url) throw new ImageGenerationError('Higgsfield returned no upload URL', { code: 'bad_response' });
  const put = await fetchImpl(slot.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(slot.upload_headers || {}) },
    body: buffer,
  });
  if (!put.ok) throw new ImageGenerationError(`Upload failed: ${put.status}`, { status: put.status, code: 'http' });
  return { url: slot.public_url };
}

/**
 * Submit one image job. Returns as soon as Higgsfield accepts it.
 * Throws `code: 'busy'` when the account's concurrency is full.
 */
export async function submitImage({
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  params = {},
  webhookUrl,
  credentials,
  fetch,
} = {}) {
  const spec = IMAGE_MODELS[model];
  if (!spec) throw new ImageGenerationError(`Unknown image model "${model}"`, { code: 'bad_response' });
  if (!prompt || !String(prompt).trim()) throw new ImageGenerationError('A prompt is required', { code: 'bad_response' });
  const call = client({ credentials, fetch });
  const qs = webhookUrl ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : '';
  const body = await call(`${BASE}${spec.path}${qs}`, { method: 'POST', body: JSON.stringify({ ...params, prompt: String(prompt) }) });
  if (!body.request_id) throw new ImageGenerationError('Higgsfield returned no request_id', { code: 'bad_response' });
  return { requestId: body.request_id, status: body.status, model };
}

/**
 * One status check. `{ status, url, error }`, where status is Higgsfield's:
 * queued | in_progress | completed | failed | nsfw | canceled.
 * Throws `code: 'not_found'` if Higgsfield no longer knows the id.
 */
export async function getImageStatus(requestId, { credentials, fetch } = {}) {
  if (!requestId) throw new ImageGenerationError('A requestId is required', { code: 'bad_response' });
  const call = client({ credentials, fetch });
  return readResult(await call(`${BASE}/requests/${encodeURIComponent(requestId)}/status`, { method: 'GET' }));
}

/**
 * Cancel a job that is still QUEUED at Higgsfield — refunded, per the docs.
 * For a person pressing Cancel, never for a timeout: a job that has started
 * can't be cancelled (400, surfaced as `code: 'started'`) and will be charged
 * when it completes regardless.
 */
export async function cancelRequest(requestId, { credentials, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!requestId) throw new ImageGenerationError('A requestId is required', { code: 'bad_response' });
  client({ credentials, fetch: fetchImpl }); // validates credentials
  const creds = credentials ?? process.env.HF_CREDENTIALS;
  const res = await fetchImpl(`${BASE}/requests/${encodeURIComponent(requestId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Key ${creds}`, Accept: 'application/json' },
  });
  if (res.ok) return { cancelled: true };
  const body = await res.json().catch(() => null);
  const detail = body?.detail || body?.error || res.statusText;
  const code = res.status === 400 ? 'started' : res.status === 404 ? 'not_found' : 'http';
  throw new ImageGenerationError(`Higgsfield ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, { status: res.status, requestId, code });
}

export const isFinished = (status) => status === 'completed' || FAILED.has(status);
export const isFailed = (status) => FAILED.has(status);

/**
 * Submit and wait — for scripts and one-offs. On `timeoutMs` it stops
 * WAITING and throws `code: 'timeout'` with the requestId, but does not
 * cancel: the job may still complete (and be charged), and can be collected
 * with getImageStatus.
 */
export async function generateImage({ timeoutMs = 300_000, pollMs = 3_000, ...opts } = {}) {
  const { requestId, model } = await submitImage(opts);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(pollMs);
    const r = await getImageStatus(requestId, opts);
    if (r.status === 'completed') {
      if (!r.url) throw new ImageGenerationError('Completed with no image', { status: r.status, requestId, code: 'bad_response' });
      return { url: r.url, requestId, model };
    }
    if (isFailed(r.status)) throw new ImageGenerationError(`Higgsfield job ${r.status}`, { status: r.status, requestId, code: 'rejected' });
    if (Date.now() >= deadline) {
      throw new ImageGenerationError(`Still running after ${timeoutMs}ms (not cancelled — collect it with getImageStatus)`, { status: r.status, requestId, code: 'timeout' });
    }
  }
}
