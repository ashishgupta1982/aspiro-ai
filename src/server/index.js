/**
 * @aspiro/ai — server.
 *
 * Imports the Anthropic SDK, so never import this from a client component.
 */
export { getClient, resetClient } from './client.js';
export { callClaude, textOf, wasTruncated } from './call.js';
export { runToolLoop } from './toolLoop.js';
export { createModelResolver, createAdminModelsHandler } from './modelConfig.js';
export {
  windowStart,
  createWindowedCounter,
  createClaudeRateLimit,
  createMongoCounter,
  rateLimitResponse,
} from './rateLimit.js';
export { withCaching, cacheSystem, cacheTools, cacheStats } from './caching.js';

// Re-exported for convenience so a server route needs one import, not two.
export {
  MODELS,
  TIERS,
  VALID_MODELS,
  normalizeModel,
  estimateCost,
  extractJson,
} from '../index.js';
