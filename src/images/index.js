/**
 * @aspiro/ai/images — image generation. Server-side only (it needs the API key).
 *
 * A second provider, so its own entry point rather than a retrofit of the
 * Claude-only core: see CLAUDE.md, "This package is Claude-only, on purpose".
 */
export {
  submitImage,
  getImageStatus,
  generateImage,
  readResult,
  isFinished,
  isFailed,
  ImageGenerationError,
} from './higgsfield.js';
export { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, isValidImageModel } from './models.js';
