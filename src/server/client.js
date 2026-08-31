import Anthropic from '@anthropic-ai/sdk';

/**
 * One Anthropic client per process.
 *
 * Replaces 43 hand-rolled `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`
 * calls across the suite, several of which constructed a fresh client per
 * request.
 *
 * On retries: the SDK already retries 408, 409, 429 and every 5xx (so 529
 * overloads too) with exponential backoff, honouring `retry-after`. Default is
 * `maxRetries: 2`, i.e. three attempts. This package deliberately adds NO retry
 * layer of its own — stacking one would multiply out to nine attempts and turn
 * a real outage into a slow, expensive one.
 */
let client = null;
let clientKey = null;

export function getClient({ apiKey, maxRetries, timeout } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('[aspiro-ai] ANTHROPIC_API_KEY is not set');
  }
  // Rebuild if the key changed (only really happens in tests).
  if (client && clientKey === key) return client;

  const options = { apiKey: key };
  if (maxRetries !== undefined) options.maxRetries = maxRetries;
  if (timeout !== undefined) options.timeout = timeout;

  client = new Anthropic(options);
  clientKey = key;
  return client;
}

/** Drop the singleton. Tests only. */
export function resetClient() {
  client = null;
  clientKey = null;
}
