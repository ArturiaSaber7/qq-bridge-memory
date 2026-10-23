import { MemoryError } from './contracts.js';
/** 与真实 DSH 输出上限契约对齐；不能把提示词要求当成模型硬限制。 */
export function createMemoryModelAdapter({ generate, hasBoundedPreset }) {
  return { async generate(request) {
    if (!await hasBoundedPreset() || request.limits.maxOutputTokens < 1000) {
      const error = new MemoryError('CAPABILITY_UNAVAILABLE', '缺少受限记忆整理预设或输出额度小于预设上限', 503);
      error.notSent = true; throw error;
    }
    return generate(request);
  } };
}
