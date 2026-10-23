// 只复制声明过的配置字段，避免不可信对象改变内部配置或原型。
import { MemoryError } from './contracts.js';
export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  enabled: false, mode: 'shadow', storage: { file: 'state/memory.sqlite' },
  recall: { normalMaxItems: 6, normalMaxTokens: 800, deepMaxTokens: 3000, lexicalCandidates: 20, vectorCandidates: 20, normalGraphDepth: 1, timeoutMs: 300 },
  consolidation: { minMessagesAfterQuiet: 20, triggerMessages: 80, quietMs: 600000, minIntervalMs: 1800000, maxRequestsPerAccountDay: 4, maxInputTokensPerRequest: 12000, maxOutputTokensPerRequest: 1500 },
  reflection: { maxRequestsPerAccountDay: 1, maxInputTokensPerRequest: 6000, maxOutputTokensPerRequest: 1000 },
  budget: { timeZone: 'Asia/Shanghai', dailyCostLimitCny: null },
  vault: { enabled: false, path: '', importBindings: [] }
});
/** 返回独立配置；非法阈值拒绝而非静默放宽额度。 */
export function resolveMemoryConfig(raw = {}) {
  const config = structuredClone(DEFAULT_MEMORY_CONFIG);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new MemoryError('INVALID_INPUT', 'enabled 必须为布尔值');
    config.enabled = raw.enabled;
  }
  if (raw.mode !== undefined) {
    if (!['shadow', 'active'].includes(raw.mode)) throw new MemoryError('INVALID_INPUT', 'mode 必须为 shadow 或 active');
    config.mode = raw.mode;
  }
  for (const group of ['recall', 'consolidation', 'reflection']) {
    for (const key of Object.keys(config[group])) if (raw[group]?.[key] !== undefined) {
      const value = raw[group][key];
      if (!Number.isSafeInteger(value) || value < 1 || value > 86400000) throw new MemoryError('INVALID_INPUT', `${group}.${key} 必须为合理的正整数`);
      config[group][key] = value;
    }
  }
  if (typeof raw.storage?.file === 'string' && raw.storage.file.trim()) config.storage.file = raw.storage.file;
  if (raw.budget?.timeZone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: raw.budget.timeZone }); } catch { throw new MemoryError('INVALID_INPUT', 'timeZone 无效'); }
    config.budget.timeZone = raw.budget.timeZone;
  }
  if (raw.budget?.dailyCostLimitCny != null) {
    if (!Number.isFinite(raw.budget.dailyCostLimitCny) || raw.budget.dailyCostLimitCny <= 0) throw new MemoryError('INVALID_INPUT', 'dailyCostLimitCny 必须为正数或 null');
    config.budget.dailyCostLimitCny = raw.budget.dailyCostLimitCny;
  }
  return config;
}
