import test from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, textOf, wasTruncated } from '../src/server/call.js';
import { withCaching, cacheSystem, cacheTools, cacheStats } from '../src/server/caching.js';

const okResponse = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'hi' }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

function clientReturning(response) {
  const sent = [];
  return { sent, messages: { create: async (params) => { sent.push(params); return response; } } };
}

const clientThrowing = (err) => ({
  messages: { create: async () => { throw err; } },
});

test('normalises a retired model id before sending', async () => {
  const client = clientReturning(okResponse);
  await callClaude(
    { model: 'claude-sonnet-4-20250514', max_tokens: 10, messages: [] },
    { client },
  );
  assert.equal(client.sent[0].model, 'claude-sonnet-4-6');
});

test('passes every other param through untouched', async () => {
  const client = clientReturning(okResponse);
  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'be brief',
    messages: [{ role: 'user', content: 'x' }],
    temperature: 0.2,
  };
  await callClaude(params, { client });
  assert.deepEqual(client.sent[0], params);
});

test('wraps an API error with a code and a debug block', async () => {
  const apiErr = Object.assign(new Error('overloaded'), {
    status: 529,
    request_id: 'req_abc',
    error: { type: 'overloaded_error', message: 'Overloaded' },
  });
  await assert.rejects(
    () => callClaude({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [] },
      { client: clientThrowing(apiErr) }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_529');
      assert.equal(err.status, 529);
      assert.equal(err.debug.request_id, 'req_abc');
      assert.equal(err.debug.type, 'overloaded_error');
      assert.equal(err.debug.model, 'claude-sonnet-4-6');
      return true;
    },
  );
});

test('a non-HTTP failure still yields a usable error', async () => {
  await assert.rejects(
    () => callClaude({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [] },
      { client: clientThrowing(new Error('socket hang up')) }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_ERROR');
      assert.equal(err.debug.message, 'socket hang up');
      return true;
    },
  );
});

test('textOf joins every text block and skips the rest', () => {
  const response = {
    content: [
      { type: 'text', text: 'one ' },
      { type: 'tool_use', id: 't', name: 'x', input: {} },
      { type: 'text', text: 'two' },
    ],
  };
  assert.equal(textOf(response), 'one two');
  assert.equal(textOf({ content: [] }), '');
  assert.equal(textOf(null), '');
});

test('textOf strips citations only on request', () => {
  const response = { content: [{ type: 'text', text: 'a <cite id="1">x</cite> b' }] };
  assert.match(textOf(response), /<cite/);
  assert.equal(textOf(response, { stripCitations: true }), 'a  b');
});

test('wasTruncated detects a max_tokens cut-off', () => {
  assert.equal(wasTruncated({ stop_reason: 'max_tokens' }), true);
  assert.equal(wasTruncated({ stop_reason: 'end_turn' }), false);
  assert.equal(wasTruncated(null), false);
});

// --- caching is opt-in ---------------------------------------------------

test('nothing is cached unless asked', () => {
  const params = { system: 'long prompt', tools: [{ name: 'a' }] };
  const out = withCaching(params, {});
  assert.equal(out.system, 'long prompt');
  assert.equal(out.tools[0].cache_control, undefined);
});

test('cacheSystem wraps a string into a marked content block', () => {
  const blocks = cacheSystem('long prompt');
  assert.deepEqual(blocks, [
    { type: 'text', text: 'long prompt', cache_control: { type: 'ephemeral' } },
  ]);
});

test('cacheSystem marks only the LAST block of an array', () => {
  const blocks = cacheSystem([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.equal(blocks[0].cache_control, undefined);
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
});

test('cacheTools marks the last tool, which covers the whole array', () => {
  const tools = cacheTools([{ name: 'a' }, { name: 'b' }]);
  assert.equal(tools[0].cache_control, undefined);
  assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' });
});

test('caching never mutates the caller-owned objects', () => {
  const system = [{ type: 'text', text: 'a' }];
  const tools = [{ name: 'a' }];
  withCaching({ system, tools }, { system: true, tools: true });
  assert.equal(system[0].cache_control, undefined);
  assert.equal(tools[0].cache_control, undefined);
});

test('cacheStats reads the usage counters', () => {
  assert.deepEqual(
    cacheStats({ usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 90 } }),
    { created: 10, read: 90 },
  );
  assert.deepEqual(cacheStats({}), { created: 0, read: 0 });
});
