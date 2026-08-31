import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelResolver, createAdminModelsHandler } from '../src/server/modelConfig.js';
import { TIERS, VALID_MODELS } from '../src/index.js';

const DEFAULTS = { chat: 'claude-sonnet-4-6', parsing: 'claude-haiku-4-5-20251001' };

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

test('falls back to defaults when nothing is stored', async () => {
  const r = createModelResolver({ defaults: DEFAULTS, loadConfig: async () => null });
  assert.equal(await r.getModel('chat'), DEFAULTS.chat);
  assert.deepEqual(await r.getModels(), DEFAULTS);
});

test('stored config wins over defaults', async () => {
  const r = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => ({ chat: 'claude-opus-4-8' }),
  });
  assert.equal(await r.getModel('chat'), 'claude-opus-4-8');
  assert.equal(await r.getModel('parsing'), DEFAULTS.parsing);
});

test('a retired stored id heals on read', async () => {
  // No data migration needed — this is the whole point.
  const r = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => ({ chat: 'claude-sonnet-4-20250514' }),
  });
  assert.equal(await r.getModel('chat'), 'claude-sonnet-4-6');
});

test('an unknown task falls back rather than returning undefined', async () => {
  const r = createModelResolver({ defaults: DEFAULTS, loadConfig: async () => ({}) });
  assert.equal(await r.getModel('nope'), DEFAULTS.chat);
});

test('caches for the TTL and invalidates on demand', async () => {
  let loads = 0;
  let value = 'claude-sonnet-4-6';
  const r = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => { loads++; return { chat: value }; },
  });

  await r.getModel('chat');
  await r.getModel('chat');
  assert.equal(loads, 1, 'second read should hit the cache');

  value = 'claude-opus-4-8';
  assert.equal(await r.getModel('chat'), 'claude-sonnet-4-6', 'still cached');

  r.invalidate();
  assert.equal(await r.getModel('chat'), 'claude-opus-4-8');
  assert.equal(loads, 2);
});

test('a load failure serves defaults instead of throwing', async () => {
  const r = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => { throw new Error('mongo down'); },
  });
  assert.equal(await r.getModel('chat'), DEFAULTS.chat);
});

test('setModels writes and drops the cache', async () => {
  const store = {};
  const r = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => ({ ...store }),
    saveConfig: async (partial) => Object.assign(store, partial),
  });

  await r.getModels();
  await r.setModels({ chat: 'claude-opus-4-8' });
  assert.equal(await r.getModel('chat'), 'claude-opus-4-8');
});

test('setModels without saveConfig is a clear error', async () => {
  const r = createModelResolver({ defaults: DEFAULTS, loadConfig: async () => ({}) });
  await assert.rejects(() => r.setModels({ chat: 'claude-opus-4-8' }), /saveConfig/);
});

// --- admin handler -------------------------------------------------------

function adminSetup() {
  const store = {};
  const resolver = createModelResolver({
    defaults: DEFAULTS,
    loadConfig: async () => ({ ...store }),
    saveConfig: async (partial) => Object.assign(store, partial),
  });
  const handler = createAdminModelsHandler({
    resolver,
    requireAdmin: async () => ({ id: 'admin' }),
  });
  return { store, resolver, handler };
}

test('GET answers all three shapes the existing admin pages read', async () => {
  const { handler } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.chat, DEFAULTS.chat, 'bare map (CookBook, Tutor App)');
  assert.equal(res.body.aiModels.chat, DEFAULTS.chat, 'wrapped (RunCoach)');
  assert.equal(res.body.models.chat, DEFAULTS.chat, 'canonical (chessMaster)');
  assert.deepEqual(res.body.validModels, VALID_MODELS);
  assert.deepEqual(res.body.defaults, DEFAULTS);
});

test('PUT accepts a bare map and persists it', async () => {
  const { handler, store } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'PUT', body: { chat: 'claude-opus-4-8' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(store.chat, 'claude-opus-4-8');
  assert.equal(res.body.models.chat, 'claude-opus-4-8');
});

test('PUT accepts the { aiModels } wrapper too', async () => {
  const { handler, store } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'PUT', body: { aiModels: { parsing: 'claude-opus-4-8' } } }, res);
  assert.equal(store.parsing, 'claude-opus-4-8');
});

test('PUT rejects a model that is not in the registry', async () => {
  const { handler, store } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'PUT', body: { chat: 'claude-cheap-and-fake' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(store, {}, 'nothing should have been written');
});

test('PUT ignores unknown task keys', async () => {
  const { handler, store } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'PUT', body: { notATask: 'claude-opus-4-8' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(store, {});
});

test('a denied admin gets no data and no write', async () => {
  const resolver = createModelResolver({ defaults: DEFAULTS, loadConfig: async () => ({}) });
  const handler = createAdminModelsHandler({
    resolver,
    requireAdmin: async (req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    },
  });
  const res = fakeRes();
  await handler({ method: 'PUT', body: { chat: 'claude-opus-4-8' } }, res);
  assert.equal(res.statusCode, 401, 'the resolver must not overwrite a 401 with 403');
});

test('unsupported methods get 405 and an Allow header', async () => {
  const { handler } = adminSetup();
  const res = fakeRes();
  await handler({ method: 'DELETE' }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.headers.Allow, ['GET', 'PUT']);
});
