import { normalizeModel, VALID_MODELS, MODELS } from '../models.js';

const DEFAULT_TTL = 5 * 60 * 1000;

/**
 * Per-workload model config with a short in-process cache.
 *
 * Where the config is STORED is the app's business — that is `loadConfig`. Two
 * of the suite's apps already keep it in a Mongo `AppConfig` document; the rest
 * wrote a JSON file at runtime, which cannot work on Vercel (`/var/task` is
 * read-only, so the save threw EROFS, and even a successful write would vanish
 * at the next cold start). Migrating those apps to a Mongo loader is the point
 * of this factory.
 *
 * Every value is passed through `normalizeModel` on the way out, so a stored id
 * that Anthropic has since retired heals on read instead of 404-ing the user.
 *
 * @param {object}   o
 * @param {object}   o.defaults   task name -> model id or tier. FALLBACKS only:
 *   once an admin saves anything, the stored value wins for that key.
 * @param {Function} o.loadConfig async () => ({ task: modelId }) | null.
 * @param {Function} [o.saveConfig] async (partial) => void. Needed only by the
 *   admin handler.
 * @param {number}   [o.ttlMs=300000]
 */
export function createModelResolver({ defaults = {}, loadConfig, saveConfig, ttlMs = DEFAULT_TTL } = {}) {
  if (typeof loadConfig !== 'function') {
    throw new Error('[aspiro-ai] createModelResolver needs a loadConfig function');
  }

  const keys = Object.keys(defaults);
  const fallbackKey = keys[0];
  let cache = null;
  let cachedAt = 0;

  async function stored() {
    const now = Date.now();
    if (cache && now - cachedAt < ttlMs) return cache;
    try {
      cache = (await loadConfig()) || {};
      cachedAt = now;
    } catch (err) {
      console.error('[aspiro-ai] model config load failed:', err.message);
      // Serve stale rather than nothing — a DB blip should not change models.
      if (!cache) cache = {};
    }
    return cache;
  }

  /** Effective id for one task. */
  async function getModel(key) {
    const config = await stored();
    const raw = config[key] || defaults[key] || defaults[fallbackKey];
    return normalizeModel(raw, defaults[key] || defaults[fallbackKey]);
  }

  /** Every task's effective id. */
  async function getModels() {
    const config = await stored();
    const out = {};
    for (const key of keys) {
      out[key] = normalizeModel(config[key] || defaults[key], defaults[key]);
    }
    return out;
  }

  async function setModels(partial) {
    if (typeof saveConfig !== 'function') {
      throw new Error('[aspiro-ai] createModelResolver needs saveConfig to write');
    }
    await saveConfig(partial);
    invalidate();
  }

  function invalidate() {
    cache = null;
    cachedAt = 0;
  }

  return { getModel, getModels, setModels, invalidate, defaults, keys };
}

/**
 * The admin GET/PUT route, which five apps had each written out by hand.
 *
 * The response is a deliberate superset. Those five clients read three
 * different shapes — bare `{ task: id }`, `{ aiModels }`, and
 * `{ models, defaults, validModels }` — so returning all three keeps every
 * existing admin page working untouched. Canonical fields are written last, so
 * a task literally named `models` cannot shadow them.
 *
 * @param {object}   o
 * @param {object}   o.resolver      from createModelResolver.
 * @param {Function} o.requireAdmin  async (req, res) => user | null. Return null
 *   AFTER sending your own response to deny — same contract as
 *   `resolveOwner` in @aspiro/media.
 */
export function createAdminModelsHandler({ resolver, requireAdmin } = {}) {
  if (!resolver) throw new Error('[aspiro-ai] createAdminModelsHandler needs a resolver');
  if (typeof requireAdmin !== 'function') {
    throw new Error('[aspiro-ai] createAdminModelsHandler needs a requireAdmin function');
  }

  return async function adminModelsHandler(req, res) {
    if (!['GET', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', ['GET', 'PUT']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const admin = await requireAdmin(req, res);
    if (!admin) {
      // requireAdmin sends its own response; only backstop if it did not.
      if (!res.headersSent && !res.writableEnded) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return undefined;
    }

    const respond = (models) =>
      res.status(200).json({
        ...models,
        models,
        aiModels: models,
        defaults: resolver.defaults,
        validModels: VALID_MODELS,
        options: VALID_MODELS.map((id) => ({ id, label: MODELS[id].label })),
      });

    if (req.method === 'GET') {
      return respond(await resolver.getModels());
    }

    // PUT — accept either a bare map or { aiModels: {...} }.
    const body = req.body?.aiModels || req.body || {};
    const update = {};
    for (const key of resolver.keys) {
      const value = body[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !VALID_MODELS.includes(value)) {
        return res.status(400).json({ error: `Unsupported model for ${key}: ${value}` });
      }
      update[key] = value;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await resolver.setModels(update);
    return respond(await resolver.getModels());
  };
}
