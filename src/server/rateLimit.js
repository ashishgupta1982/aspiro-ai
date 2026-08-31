/**
 * Durable, fixed-window rate limiting.
 *
 * The in-memory limiters every app ships reset on each serverless cold start
 * and multiply by instance count, so they are burst shields and nothing more.
 * These counters live in the database and are the real budget — which for
 * Claude routes means the real spend cap.
 *
 * Ported from chessMaster, the only app that had it. Split in two on the way:
 * the windowed counting is generic, the shared ceiling across every Claude
 * route is the Claude-specific part and the bit that actually bounds a bill.
 *
 * Storage is a hook. The package must not know your data layer — and when a
 * platform package eventually owns the counter, the app passes that in and
 * nothing here changes.
 */

const WINDOWS = [
  ['h', 60 * 60 * 1000],
  ['d', 24 * 60 * 60 * 1000],
];

/** Start of the fixed window containing `now`. Pure — unit-tested. */
export function windowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * @param {object}   o
 * @param {Function} o.count  async (key, { windowMs, windowStart, expiresAt })
 *   => new count. Must atomically increment and return the post-increment
 *   value, or the limit leaks under concurrency.
 * @param {object}   o.buckets  name -> { hour, day }. Per-app: these numbers are
 *   tuned to an app's cost per call and are not the package's business.
 */
export function createWindowedCounter({ count, buckets = {} } = {}) {
  if (typeof count !== 'function') {
    throw new Error('[aspiro-ai] createWindowedCounter needs a count function');
  }

  /**
   * Count one request against a bucket and report whether it is within limits.
   * @returns {Promise<{allowed:boolean, retryAfter?:number, window?:'hour'|'day'}>}
   *   retryAfter is seconds until the violated window resets.
   */
  async function check(userId, bucket) {
    const limits = buckets[bucket];
    if (!limits) throw new Error(`[aspiro-ai] unknown rate bucket: ${bucket}`);

    const now = Date.now();
    let verdict = { allowed: true };

    for (const [tag, windowMs] of WINDOWS) {
      const limit = tag === 'h' ? limits.hour : limits.day;
      if (!limit) continue;
      const start = windowStart(now, windowMs);
      const key = `${userId}:${bucket}:${tag}:${start}`;
      const current = await count(key, {
        windowMs,
        windowStart: start,
        // Keep docs a while past the window so TTL lag cannot resurrect budget.
        expiresAt: new Date(start + windowMs * 2),
      });

      if (current > limit && verdict.allowed) {
        verdict = {
          allowed: false,
          window: tag === 'h' ? 'hour' : 'day',
          retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
        };
      }
    }

    return verdict;
  }

  return { check, buckets };
}

/**
 * Two-tier check: the route's own bucket, then a ceiling shared by every Claude
 * route. The ceiling is what caps the bill — a per-feature limit alone lets a
 * user spend N times over by rotating between features.
 *
 * Call this ONCE per request, before the model call. Never inside a retry: the
 * SDK's three attempts are one unit of user-visible work and must cost one unit
 * of budget.
 */
export function createClaudeRateLimit({ counter, ceiling = 'claude-total' } = {}) {
  if (!counter?.check) {
    throw new Error('[aspiro-ai] createClaudeRateLimit needs a counter');
  }

  return async function checkClaudeRate(userId, bucket) {
    const own = await counter.check(userId, bucket);
    if (!own.allowed) return own;
    if (!ceiling || !counter.buckets[ceiling]) return own;
    return counter.check(userId, ceiling);
  };
}

/**
 * Mongo-backed counter: one document per (user, bucket, window), keyed by a
 * composite string `_id` so a single atomic upsert-$inc both creates and counts.
 *
 * The app owns the model so the package needs no mongoose dependency. It wants
 * a string `_id`, a numeric `count`, and a TTL index on `expiresAt`:
 *
 *   RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
 */
export function createMongoCounter({ model, connect } = {}) {
  if (!model) throw new Error('[aspiro-ai] createMongoCounter needs a model');

  return async function count(key, { expiresAt }) {
    if (typeof connect === 'function') await connect();
    const doc = await model
      .findOneAndUpdate(
        { _id: key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, new: true },
      )
      .lean();
    return doc.count;
  };
}

/** Uniform 429 payload for a failed check. */
export function rateLimitResponse(res, verdict, what = 'requests') {
  const period = verdict.window === 'hour' ? 'hourly' : 'daily';
  if (verdict.retryAfter) res.setHeader('Retry-After', String(verdict.retryAfter));
  return res.status(429).json({
    error: `You've hit the ${period} limit for ${what}. Please try again later.`,
    retryAfter: verdict.retryAfter,
  });
}
