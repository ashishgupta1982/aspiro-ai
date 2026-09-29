/**
 * Image models — the one place an image model id is written, the same rule
 * `../models.js` holds for Claude.
 *
 * Higgsfield's HTTP API (https://docs.higgsfield.ai), billed from a prepaid
 * API balance at console.higgsfield.ai. That balance is separate from a
 * Higgsfield web/CLI subscription: Plus credits cannot be spent from here.
 *
 * `path` is the model's submit endpoint on https://api.higgsfield.ai.
 * Checked against the docs 2026-09-29. The docs list only `prompt` for Soul
 * v2, so no aspect-ratio or resolution field is assumed; pass extras through
 * `params` once confirmed.
 */
export const IMAGE_MODELS = {
  'soul-v2': {
    label: 'Soul 2 (standard)',
    provider: 'higgsfield',
    path: '/higgsfield-ai/soul/v2/standard',
  },
};

export const DEFAULT_IMAGE_MODEL = 'soul-v2';

export function isValidImageModel(id) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MODELS, id);
}
