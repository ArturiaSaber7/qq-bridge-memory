// 请求额度按账号/自然日共享；网络超时不能当作未调用而返还额度。
import { randomUUID } from 'node:crypto';
import { MemoryError } from './contracts.js';
export function createMemoryBudget({ store, getConfig, clock = Date.now }) {
  return {
    async reserve({ accountId, purpose, inputTokens, maxOutputTokens, jobId = null }) {
      const config = getConfig();
      const limits = purpose === 'reflection' ? config.reflection : config.consolidation;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > limits.maxInputTokensPerRequest || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > limits.maxOutputTokensPerRequest) throw new MemoryError('BUDGET_EXHAUSTED', '单次请求超过记忆额度', 409);
      // 没有可靠金额上界时不能静默绕过管理员配置的金额限制。
      if (config.budget.dailyCostLimitCny !== null) throw new MemoryError('CAPABILITY_UNAVAILABLE', '当前适配器尚不能可靠预留金额，请使用请求/token 限额或接入计价上界', 409);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.budget.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock());
      return store.transaction(() => {
        const used = store.get("SELECT count(*) n FROM memory_budget_reservation WHERE account_id=? AND day=? AND purpose=? AND status<>'released'", accountId, day, purpose).n;
        if (used >= limits.maxRequestsPerAccountDay) throw new MemoryError('BUDGET_EXHAUSTED', '今日后台生成额度已用完', 409);
        const id = randomUUID();
        store.run('INSERT INTO memory_budget_reservation(id,account_id,day,purpose,input_tokens,output_tokens,status,created_at,job_id) VALUES(?,?,?,?,?,?,?,?,?)', id, accountId, day, purpose, inputTokens, maxOutputTokens, 'reserved', clock(), jobId);
        return { reservationId: id };
      });
    },
    async settle({ reservationId, outcome, usage }) {
      const status = outcome === 'not_sent' ? 'released' : usage ? 'settled' : 'unknown';
      store.run("UPDATE memory_budget_reservation SET status=?,usage=? WHERE id=? AND status='reserved'", status, usage ? JSON.stringify(usage) : null, reservationId);
    }
  };
}
