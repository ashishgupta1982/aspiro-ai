import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from './models.js';

/**
 * Generate one image on Higgsfield and return its URL.
 *
 * The API is asynchronous: a submit returns a `request_id`, and the status
 * endpoint is polled until the job reaches a terminal state. The finished
 * image is at `images[0].url`, hosted by Higgsfield for at least seven days,
 * so a caller that wants to keep it must copy it (e.g. `uploadBuffer` in
 * `@aspiro/media/server`). Fetching that URL is the caller's job, behind its
 * own SSRF guard — this function never downloads anything.
 *
 * On timeout the job is cancelled, so a request nobody is waiting for does
 * not run on and get billed. Server-side only: it needs the API key.
 */
const BASE = 'https://api.higgsfield.ai';
const TERMINAL_FAIL = new Set(['failed', 'nsfw', 'canceled', 'cancelled']);

export class ImageGenerationError extends Error {
  constructor(message, { status, requestId, code } = {}) {
    super(message);
    this.name = 'ImageGenerationError';
    this.status = status; // Higgsfield's job status, or the HTTP status
    this.requestId = requestId;
    this.code = code; // 'no_credentials' | 'http' | 'rejected' | 'timeout' | 'bad_response'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generateImage({
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  params = {},
  credentials = process.env.HF_CREDENTIALS,
  timeoutMs = 50_000,
  pollMs = 2_000,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!credentials || !String(credentials).includes(':')) {
    throw new ImageGenerationError('HF_CREDENTIALS is not set (expected "<key id>:<key secret>")', { code: 'no_credentials' });
  }
  const spec = IMAGE_MODELS[model];
  if (!spec) throw new ImageGenerationError(`Unknown image model "${model}"`, { code: 'bad_response' });
  if (!prompt || !String(prompt).trim()) throw new ImageGenerationError('A prompt is required', { code: 'bad_response' });

  const headers = { Authorization: `Key ${credentials}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (url, init) => {
    const res = await fetchImpl(url, { ...init, headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.detail || body?.error || body?.message || res.statusText;
      throw new ImageGenerationError(`Higgsfield ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, { status: res.status, code: 'http' });
    }
    return body || {};
  };

  const submitted = await call(`${BASE}${spec.path}`, { method: 'POST', body: JSON.stringify({ ...params, prompt: String(prompt) }) });
  const requestId = submitted.request_id;
  if (!requestId) throw new ImageGenerationError('Higgsfield returned no request_id', { code: 'bad_response' });
  const statusUrl = submitted.status_url || `${BASE}/requests/${requestId}/status`;
  const cancelUrl = submitted.cancel_url || `${BASE}/requests/${requestId}/cancel`;

  const deadline = Date.now() + timeoutMs;
  let job = submitted;
  for (;;) {
    if (job.status === 'completed') {
      const url = job.images?.[0]?.url;
      if (!url) throw new ImageGenerationError('Completed with no image', { status: job.status, requestId, code: 'bad_response' });
      return { url, requestId, model };
    }
    if (TERMINAL_FAIL.has(job.status)) {
      throw new ImageGenerationError(`Higgsfield job ${job.status}`, { status: job.status, requestId, code: 'rejected' });
    }
    if (Date.now() >= deadline) {
      await fetchImpl(cancelUrl, { method: 'POST', headers }).catch(() => {});
      throw new ImageGenerationError(`Timed out after ${timeoutMs}ms`, { status: job.status, requestId, code: 'timeout' });
    }
    await sleep(pollMs);
    job = await call(statusUrl, { method: 'GET' });
  }
}
