/**
 * @aspiro/ai — core.
 *
 * Pure and dependency-free, so it is safe to import from client components,
 * server routes and standalone scripts alike. Anything that needs the Anthropic
 * SDK or a database lives behind `@aspiro/ai/server`.
 *
 * Scope note: this package is Claude-only. The name leaves room for a sibling
 * provider later, but nothing here pretends to abstract one — the tool loop
 * returns Anthropic content blocks and `cache_control` is an Anthropic concept.
 * A second provider would get its own entry point, not a retrofit of this one.
 */
export {
  MODELS,
  TIERS,
  VALID_MODELS,
  LEGACY_ALIASES,
  isValidModel,
  normalizeModel,
  modelCost,
  estimateCost,
  modelOptions,
} from './models.js';

export { extractJson } from './json.js';
