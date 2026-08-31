import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS, TIERS, VALID_MODELS, normalizeModel, isValidModel,
  modelCost, estimateCost, modelOptions, extractJson,
} from '../src/index.js';

test('every tier points at a real model', () => {
  for (const [tier, id] of Object.entries(TIERS)) {
    assert.ok(isValidModel(id), `${tier} -> ${id}`);
    assert.equal(MODELS[id].tier, tier, `${id} should self-report tier ${tier}`);
  }
});

test('VALID_MODELS is ordered cheapest first', () => {
  const costs = VALID_MODELS.map((id) => MODELS[id].cost.input);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
});

test('normalizeModel maps retired ids to live ones', () => {
  // The exact failure that broke MoneyHub in production.
  assert.equal(normalizeModel('claude-sonnet-4-20250514'), 'claude-sonnet-4-6');
  assert.equal(normalizeModel('claude-sonnet-4-6-20250627'), 'claude-sonnet-4-6');
});

test('normalizeModel accepts tier names', () => {
  assert.equal(normalizeModel('fast'), TIERS.fast);
  assert.equal(normalizeModel('deep'), TIERS.deep);
});

test('normalizeModel falls back rather than throwing', () => {
  assert.equal(normalizeModel('claude-imaginary-9'), TIERS.balanced);
  assert.equal(normalizeModel(undefined), TIERS.balanced);
  assert.equal(normalizeModel(null, 'fast'), TIERS.fast);
  assert.equal(normalizeModel('junk', 'claude-opus-4-8'), 'claude-opus-4-8');
});

test('normalizeModel leaves a valid id alone', () => {
  for (const id of VALID_MODELS) assert.equal(normalizeModel(id), id);
});

test('Haiku keeps its date suffix and the others do not', () => {
  // Not an inconsistency: there is no bare `claude-haiku-4-5`, and 4.6+ ids are
  // rejected WITH a suffix. Getting this backwards is a silent 404.
  assert.match(TIERS.fast, /-\d{8}$/);
  assert.doesNotMatch(TIERS.balanced, /-\d{8}$/);
  assert.doesNotMatch(TIERS.deep, /-\d{8}$/);
});

test('cost helpers', () => {
  assert.deepEqual(modelCost('claude-sonnet-4-6'), { input: 3, output: 15 });
  assert.deepEqual(modelCost('nonsense'), modelCost(TIERS.balanced));
  // 1M in + 1M out on Sonnet = $3 + $15
  assert.equal(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
  assert.equal(estimateCost('claude-sonnet-4-6', 0, 0), 0);
});

test('modelOptions gives an admin picker its rows', () => {
  const rows = modelOptions();
  assert.equal(rows.length, VALID_MODELS.length);
  assert.ok(rows.every((r) => r.id && r.label && r.tier && r.cost));
});

test('extractJson: direct, fenced and prose-prefixed', () => {
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('Here you go: [{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson recovers a response truncated at max_tokens', () => {
  const truncated = '[{"id":1,"name":"one"},{"id":2,"name":"two"},{"id":3,"na';
  assert.deepEqual(extractJson(truncated), [
    { id: 1, name: 'one' },
    { id: 2, name: 'two' },
  ]);
});

test('extractJson is not fooled by brackets inside strings', () => {
  const text = '[{"note":"a ] and a } inside"},{"note":"fine"}]';
  assert.deepEqual(extractJson(text), [
    { note: 'a ] and a } inside' },
    { note: 'fine' },
  ]);
});

test('extractJson returns null when there is nothing to salvage', () => {
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson('[{"incomplete":'), null);
});
