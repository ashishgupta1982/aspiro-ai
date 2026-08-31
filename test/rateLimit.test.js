import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowStart, createWindowedCounter, createClaudeRateLimit,
  createMongoCounter, rateLimitResponse,
} from '../src/server/rateLimit.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** In-memory stand-in for the Mongo counter. */
function memoryCounter() {
  const counts = new Map();
  const fn = async (key) => {
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    return next;
  };
  fn.counts = counts;
  return fn;
}

const BUCKETS = {
  'claude-insights': { hour: 2, day: 3 },
  'claude-blunders': { hour: 5, day: 10 },
  'claude-total': { hour: 3, day: 4 },
};

test('windowStart snaps to the containing fixed window', () => {
  assert.equal(windowStart(0, HOUR), 0);
  assert.equal(windowStart(HOUR - 1, HOUR), 0);
  assert.equal(windowStart(HOUR, HOUR), HOUR);
  assert.equal(windowStart(HOUR * 3 + 5, HOUR), HOUR * 3);
  assert.equal(windowStart(DAY + 1, DAY), DAY);
});

test('allows up to the limit then denies', async () => {
  const counter = createWindowedCounter({ count: memoryCounter(), buckets: BUCKETS });
  assert.equal((await counter.check('u1', 'claude-insights')).allowed, true);
  assert.equal((await counter.check('u1', 'claude-insights')).allowed, true);
  const third = await counter.check('u1', 'claude-insights');
  assert.equal(third.allowed, false);
  assert.equal(third.window, 'hour');
  assert.ok(third.retryAfter > 0 && third.retryAfter <= 3600);
});

test('users are counted separately', async () => {
  const counter = createWindowedCounter({ count: memoryCounter(), buckets: BUCKETS });
  await counter.check('u1', 'claude-insights');
  await counter.check('u1', 'claude-insights');
  assert.equal((await counter.check('u2', 'claude-insights')).allowed, true);
});

test('buckets are counted separately', async () => {
  const counter = createWindowedCounter({ count: memoryCounter(), buckets: BUCKETS });
  await counter.check('u1', 'claude-insights');
  await counter.check('u1', 'claude-insights');
  assert.equal((await counter.check('u1', 'claude-blunders')).allowed, true);
});

test('the daily window denies even when the hourly one is fine', async () => {
  const counter = createWindowedCounter({
    count: memoryCounter(),
    buckets: { thing: { hour: 100, day: 2 } },
  });
  await counter.check('u1', 'thing');
  await counter.check('u1', 'thing');
  const verdict = await counter.check('u1', 'thing');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, 'day');
});

test('an unknown bucket is a programming error, not a silent pass', async () => {
  const counter = createWindowedCounter({ count: memoryCounter(), buckets: BUCKETS });
  await assert.rejects(() => counter.check('u1', 'typo'), /unknown rate bucket/);
});

test('both windows are counted even when the first already denied', async () => {
  // Otherwise a user parked at the hourly limit never accrues daily usage.
  const count = memoryCounter();
  const counter = createWindowedCounter({ count, buckets: BUCKETS });
  for (let i = 0; i < 4; i++) await counter.check('u1', 'claude-insights');
  const dayKeys = [...count.counts.keys()].filter((k) => k.includes(':d:'));
  assert.equal(count.counts.get(dayKeys[0]), 4);
});

test('the shared ceiling catches a user rotating between features', async () => {
  // This is the whole reason checkClaudeRate exists: per-feature limits alone
  // let someone spend N times over by switching features.
  const counter = createWindowedCounter({ count: memoryCounter(), buckets: BUCKETS });
  const checkClaudeRate = createClaudeRateLimit({ counter });

  assert.equal((await checkClaudeRate('u1', 'claude-blunders')).allowed, true);
  assert.equal((await checkClaudeRate('u1', 'claude-blunders')).allowed, true);
  assert.equal((await checkClaudeRate('u1', 'claude-blunders')).allowed, true);
  // Under claude-blunders' own limit of 5, but claude-total's hourly 3 is spent.
  const denied = await checkClaudeRate('u1', 'claude-blunders');
  assert.equal(denied.allowed, false);
});

test('the ceiling is not charged when the own bucket already denied', async () => {
  const count = memoryCounter();
  const counter = createWindowedCounter({ count, buckets: BUCKETS });
  const checkClaudeRate = createClaudeRateLimit({ counter });

  await checkClaudeRate('u1', 'claude-insights');
  await checkClaudeRate('u1', 'claude-insights');
  await checkClaudeRate('u1', 'claude-insights'); // own bucket denies here

  const totalHour = [...count.counts.entries()]
    .find(([k]) => k.includes('claude-total') && k.includes(':h:'));
  assert.equal(totalHour[1], 2, 'a rejected request must not consume the ceiling');
});

test('works with no ceiling configured', async () => {
  const counter = createWindowedCounter({
    count: memoryCounter(),
    buckets: { solo: { hour: 1, day: 1 } },
  });
  const check = createClaudeRateLimit({ counter });
  assert.equal((await check('u1', 'solo')).allowed, true);
  assert.equal((await check('u1', 'solo')).allowed, false);
});

test('the mongo counter increments atomically and returns the new count', async () => {
  const seen = [];
  const model = {
    findOneAndUpdate(filter, update, options) {
      seen.push({ filter, update, options });
      return { lean: async () => ({ _id: filter._id, count: 7 }) };
    },
  };
  let connected = false;
  const count = createMongoCounter({ model, connect: async () => { connected = true; } });

  const expiresAt = new Date(1000);
  const result = await count('u1:bucket:h:0', { expiresAt });

  assert.equal(result, 7);
  assert.equal(connected, true);
  assert.deepEqual(seen[0].update, { $inc: { count: 1 }, $setOnInsert: { expiresAt } });
  assert.equal(seen[0].options.upsert, true);
  assert.equal(seen[0].options.new, true, 'must return the POST-increment count');
});

test('rateLimitResponse sets Retry-After and a readable message', () => {
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  rateLimitResponse(res, { allowed: false, window: 'day', retryAfter: 120 }, 'coaching');
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '120');
  assert.match(res.body.error, /daily limit for coaching/);
  assert.equal(res.body.retryAfter, 120);
});
