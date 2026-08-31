/**
 * Prompt caching — OPT-IN, never automatic.
 *
 * A cache WRITE costs more than the same tokens sent normally. Caching pays
 * only when the same large prefix is re-sent inside the cache lifetime: a long
 * system prompt across a conversation, or a big tool-definition block inside a
 * tool loop, where the prefix is re-sent on every iteration.
 *
 * For a one-shot call with no reuse it is a straight loss. That is why nothing
 * in this package turns it on for you — a global default would quietly raise
 * the bill on exactly the calls that cannot benefit.
 *
 * Rules of thumb before reaching for it:
 *   - the cached prefix must clear the model's minimum (1024 tokens for Sonnet
 *     and Opus, 2048 for Haiku) or the breakpoint is ignored;
 *   - the prefix must be byte-identical between calls — interpolating a
 *     timestamp or a user name into a "static" system prompt defeats it;
 *   - it must be re-sent within the 5-minute TTL, refreshed on each hit.
 */

/**
 * Wrap a system prompt so the whole thing is cached.
 *
 * @param {string|Array} system
 * @returns {Array} content blocks with a cache breakpoint on the last one.
 */
export function cacheSystem(system) {
  if (!system) return system;
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : [...system];
  if (!blocks.length) return blocks;
  const last = blocks.length - 1;
  blocks[last] = { ...blocks[last], cache_control: { type: 'ephemeral' } };
  return blocks;
}

/**
 * Wrap tool definitions so the block is cached. The breakpoint goes on the LAST
 * tool: a breakpoint caches everything before it, so marking the final entry
 * covers the whole array.
 */
export function cacheTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  const out = [...tools];
  const last = out.length - 1;
  out[last] = { ...out[last], cache_control: { type: 'ephemeral' } };
  return out;
}

/**
 * Apply caching to a params object. Explicit call, no default.
 *
 *   withCaching(params, { system: true, tools: true })
 */
export function withCaching(params, { system = false, tools = false } = {}) {
  const out = { ...params };
  if (system && out.system) out.system = cacheSystem(out.system);
  if (tools && out.tools) out.tools = cacheTools(out.tools);
  return out;
}

/** Cache hit/write counts from a response, for logging. */
export function cacheStats(response) {
  const u = response?.usage || {};
  return {
    created: u.cache_creation_input_tokens || 0,
    read: u.cache_read_input_tokens || 0,
  };
}
