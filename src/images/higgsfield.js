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

/** Normalise a status or webhook body into `{ status, url, error }`. */
export function readResult(body = {}) {
  const images = body.images || body.payload?.images || [];
  const url = images[0]?.url || null;
  return { status: body.status, url, error: body.error || null };
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
