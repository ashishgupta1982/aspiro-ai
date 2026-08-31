import { getClient } from './client.js';
import { normalizeModel, estimateCost } from '../models.js';

/**
 * One Claude call, with the error wrapping DoIt worked out the hard way.
 *
 * A raw SDK rejection tells you almost nothing once it has crossed an API
 * route boundary — "400 Bad Request" with no model, no request id, no type. The
 * wrapped error carries a `code` and a `debug` block, which is what made
 * production failures diagnosable from Vercel logs.
 *
 * This does NOT retry. The SDK already does — see client.js.
 *
 * @param {object} params        Anthropic `messages.create` params, verbatim.
 * @param {object} [options]
 * @param {object} [options.client]     override the singleton.
 * @param {boolean} [options.logUsage]  log model / tokens / estimated cost.
 * @param {string} [options.label]      prefix for that log line.
 */
export async function callClaude(params, options = {}) {
  const { client, logUsage = false, label = 'ai' } = options;
  const anthropic = client || getClient();

  const model = normalizeModel(params.model);
  const request = { ...params, model };

  let response;
  try {
    response = await anthropic.messages.create(request);
  } catch (apiErr) {
    const wrapped = new Error(apiErr?.message || 'Anthropic API request failed');
    wrapped.code = `ANTHROPIC_${apiErr?.status || 'ERROR'}`;
    wrapped.status = apiErr?.status;
    wrapped.debug = {
      model,
      status: apiErr?.status,
      type: apiErr?.error?.type || apiErr?.name,
      message: apiErr?.error?.message || apiErr?.message,
      request_id: apiErr?.request_id,
    };
    throw wrapped;
  }

  if (logUsage) {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const cached = response.usage?.cache_read_input_tokens || 0;
    console.log(
      `[${label}] model=${model} | in=${inputTokens} out=${outputTokens}` +
        (cached ? ` cached=${cached}` : '') +
        ` | est=$${estimateCost(model, inputTokens, outputTokens).toFixed(4)}`,
    );
  }

  return response;
}

/** Join every text block in a response. */
export function textOf(response, { stripCitations = false } = {}) {
  const raw = (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!stripCitations) return raw;
  return raw
    .replace(/<cite[^>]*>.*?<\/cite>/gs, '')
    .replace(/<\/?cite[^>]*>/g, '')
    .trim();
}

/** True when the response was cut off at `max_tokens`. */
export function wasTruncated(response) {
  return response?.stop_reason === 'max_tokens';
}
