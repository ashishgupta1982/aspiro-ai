/**
 * The suite's model registry.
 *
 * This is the file that exists so a model id lives in ONE place. Before it,
 * 113 hardcoded ids were spread across 43 files, and when Anthropic retired
 * `claude-sonnet-4-20250514` every MoneyHub user who had selected it got a 404
 * until someone noticed and patched that app alone.
 *
 * Bumping the package version updates every app that installs it. That still
 * needs a redeploy per app — deliberately. A runtime fetch would propagate
 * instantly but adds a network dependency to every AI call, and the apps run on
 * Vercel while the only central service (Command Center) is loopback-only.
 */

/** Cost is USD per million tokens, checked against Anthropic's published pricing 2026-08-24. */
export const MODELS = {
  'claude-opus-4-8': {
    label: 'Opus 4.8',
    tier: 'deep',
    cost: { input: 5, output: 25 },
    contextWindow: 200000,
  },
  'claude-sonnet-4-6': {
    label: 'Sonnet 4.6',
    tier: 'balanced',
    cost: { input: 3, output: 15 },
    contextWindow: 200000,
  },
  'claude-haiku-4-5-20251001': {
    label: 'Haiku 4.5',
    tier: 'fast',
    cost: { input: 1, output: 5 },
    contextWindow: 200000,
  },
};

/**
 * Semantic tiers. Apps map their own task names onto these, so a model swap is
 * a change here rather than a sweep through eight repos.
 *
 * Note `fast` carries a date suffix and the others do not. That is not an
 * inconsistency to tidy: Haiku 4.5 genuinely ships as
 * `claude-haiku-4-5-20251001` and there is no bare `claude-haiku-4-5`, while
 * ids from 4.6 onward are bare and are rejected WITH a date suffix.
 */
export const TIERS = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-8',
};

/** Every id the suite is allowed to send, cheapest first. */
export const VALID_MODELS = Object.keys(MODELS).sort(
  (a, b) => MODELS[a].cost.input - MODELS[b].cost.input,
);

/**
 * Ids that were once written to a user record or an admin config and are no
 * longer valid. Kept forever — the whole point is that stored values heal on
 * read, so no data migration is ever needed.
 */
export const LEGACY_ALIASES = {
  'claude-sonnet-4-6-20250627': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  'claude-opus-4-6': 'claude-opus-4-8',
};

export function isValidModel(id) {
  return Object.prototype.hasOwnProperty.call(MODELS, id);
}

/**
 * Resolve whatever was stored into an id that is safe to send.
 *
 * Accepts a live id, a legacy alias, or a tier name. Anything unrecognised
 * falls back rather than throwing: a stale value in the database should degrade
 * to a working model, not break the feature.
 *
 * @param {string} stored
 * @param {string} [fallback] a model id or tier name; defaults to `balanced`.
 */
export function normalizeModel(stored, fallback = TIERS.balanced) {
  const resolvedFallback = TIERS[fallback] || (isValidModel(fallback) ? fallback : TIERS.balanced);
  if (!stored || typeof stored !== 'string') return resolvedFallback;
  if (TIERS[stored]) return TIERS[stored];
  const mapped = LEGACY_ALIASES[stored] || stored;
  return isValidModel(mapped) ? mapped : resolvedFallback;
}

/** USD per million tokens for a model id. Unknown ids price as `balanced`. */
export function modelCost(id) {
  return (MODELS[id] || MODELS[TIERS.balanced]).cost;
}

/**
 * Estimated USD for a completed call. An equivalent-cost figure at public API
 * rates, same basis as ccusage — useful as a spend gauge, not an invoice.
 */
export function estimateCost(id, inputTokens = 0, outputTokens = 0) {
  const cost = modelCost(id);
  return (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000;
}

/** Registry rows for an admin picker: `[{ id, label, tier, cost }]`, cheapest first. */
export function modelOptions() {
  return VALID_MODELS.map((id) => ({ id, ...MODELS[id] }));
}
