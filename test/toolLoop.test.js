import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/server/toolLoop.js';

/** Minimal stand-in for the Anthropic client: replays scripted responses. */
function fakeClient(script) {
  const sent = [];
  return {
    sent,
    messages: {
      create: async (params) => {
        sent.push(params);
        const next = script.shift();
        if (!next) throw new Error('fake client ran out of scripted responses');
        return {
          usage: { input_tokens: 10, output_tokens: 5 },
          ...next,
        };
      },
    },
  };
}

const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const useTool = (name, input = {}, id = 'tu_1') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

const base = {
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  system: 'be helpful',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'get_thing', input_schema: { type: 'object', properties: {} } }],
};

test('returns the shape every app already returns', async () => {
  const client = fakeClient([text('hello')]);
  const result = await runToolLoop({ ...base, client, execute: async () => ({}) });
  assert.equal(result.assistantMessage, 'hello');
  assert.deepEqual(result.toolsUsed, []);
  assert.equal(result.iterations, 0);
});

test('executes a tool and feeds the result back', async () => {
  const client = fakeClient([useTool('get_thing', { q: 1 }), text('done')]);
  const calls = [];
  const result = await runToolLoop({
    ...base,
    client,
    execute: async (name, input) => {
      calls.push([name, input]);
      return { value: 42 };
    },
  });

  assert.deepEqual(calls, [['get_thing', { q: 1 }]]);
  assert.deepEqual(result.toolsUsed, ['get_thing']);
  assert.equal(result.assistantMessage, 'done');

  const followUp = client.sent[1].messages;
  assert.equal(followUp.at(-1).role, 'user');
  assert.deepEqual(followUp.at(-1).content, [
    { type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ value: 42 }) },
  ]);
});

test('EVERY parallel tool_use gets a tool_result', async () => {
  // The API 400s with "tool_use ids were found without tool_result blocks" if
  // even one is missing. This is the invariant GolfSoc's copy would have broken.
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'get_thing', input: {} },
        { type: 'tool_use', id: 'b', name: 'get_thing', input: {} },
        { type: 'text', text: 'thinking' },
      ],
    },
    text('done'),
  ]);

  await runToolLoop({ ...base, client, execute: async () => ({ ok: true }) });

  const results = client.sent[1].messages.at(-1).content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b']);
  assert.ok(results.every((r) => r.type === 'tool_result'));
});

test('a throwing tool yields an error result, not a dead request', async () => {
  const client = fakeClient([useTool('get_thing'), text('recovered')]);
  const result = await runToolLoop({
    ...base,
    client,
    execute: async () => {
      throw new Error('database is on fire');
    },
  });

  assert.equal(result.assistantMessage, 'recovered');
  const sent = JSON.parse(client.sent[1].messages.at(-1).content[0].content);
  assert.deepEqual(sent, { error: 'database is on fire' });
});

test('an unknown tool reports back instead of hanging', async () => {
  const client = fakeClient([useTool('mystery'), text('ok')]);
  await runToolLoop({ ...base, client, execute: async () => undefined });
  const sent = JSON.parse(client.sent[1].messages.at(-1).content[0].content);
  assert.deepEqual(sent, { error: 'Unknown tool: mystery' });
});

test('joins ALL text blocks, not just the first', async () => {
  // Server-side web search returns many small text blocks, one per citation
  // segment. Taking .find() truncated the answer to its first fragment.
  const client = fakeClient([
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
    },
  ]);
  const result = await runToolLoop({ ...base, client, execute: async () => ({}) });
  assert.equal(result.assistantMessage, 'Part one. Part two.');
});

test('strips citation markup only when asked', async () => {
  const script = () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'A <cite id="1">source</cite> claim.' }],
  });
  const kept = await runToolLoop({ ...base, client: fakeClient([script()]), execute: async () => ({}) });
  assert.match(kept.assistantMessage, /<cite/);

  const stripped = await runToolLoop({
    ...base,
    client: fakeClient([script()]),
    execute: async () => ({}),
    stripCitations: true,
  });
  assert.equal(stripped.assistantMessage, 'A  claim.');
});

test('honours maxIterations and reports exhaustion', async () => {
  const client = fakeClient([useTool('get_thing'), useTool('get_thing'), useTool('get_thing')]);
  const result = await runToolLoop({
    ...base,
    client,
    execute: async () => ({}),
    maxIterations: 2,
    exhaustedMessage: 'Could you rephrase that?',
  });
  assert.equal(result.iterations, 2);
  assert.equal(result.exhausted, true);
  assert.equal(result.assistantMessage, 'Could you rephrase that?');
});

test('throwOnEmpty carries debug detail', async () => {
  const client = fakeClient([{ stop_reason: 'end_turn', content: [] }]);
  await assert.rejects(
    () => runToolLoop({ ...base, client, execute: async () => ({}), throwOnEmpty: true }),
    (err) => {
      assert.equal(err.code, 'EMPTY_RESPONSE');
      assert.equal(err.debug.model, 'claude-sonnet-4-6');
      return true;
    },
  );
});

test('excludeTools withholds tools from the request', async () => {
  const client = fakeClient([text('ok')]);
  await runToolLoop({
    ...base,
    tools: [{ name: 'keep' }, { name: 'drop' }],
    excludeTools: ['drop'],
    client,
    execute: async () => ({}),
  });
  assert.deepEqual(client.sent[0].tools.map((t) => t.name), ['keep']);
});

test('accumulates tokens across every iteration', async () => {
  const client = fakeClient([useTool('get_thing'), text('done')]);
  const result = await runToolLoop({ ...base, client, execute: async () => ({}) });
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
  assert.ok(result.estimatedCost > 0);
});

test('stops cleanly when tool_use has no executable blocks', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'web_search_tool_use', id: 'w1' }, { type: 'text', text: 'found it' }] },
  ]);
  const result = await runToolLoop({ ...base, client, execute: async () => ({}) });
  assert.equal(result.assistantMessage, 'found it');
  assert.deepEqual(result.toolsUsed, ['web_search']);
});
