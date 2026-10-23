// 回执只代表已接受的投递；压缩/重启无法证明保留内容时，必须回到 unknown。
import { MemoryError } from './contracts.js';
/** 只接受宿主实际探测到的扩展能力，不根据模型名字或1M窗口推断摘要可见性。 */
export function detectMemoryContextCapabilities({ version = null, summaryAdapter = null } = {}) {
  const supported = summaryAdapter?.verified === true && typeof summaryAdapter.install === 'function';
  return { version, native: true, qqBackend: supported, visibility: supported ? 'verifiable' : 'unknown',
    canRetireSession: true, reason: supported ? null : '没有经过验证的 QQ 摘要扩展，使用原生压缩并重新召回必要记忆' };
}

/** 摘要是上下文提示而不是证据；完整性验证失败时不生成 visible 回执。 */
export function validateMemorySummary(summary, expectedRefs) {
  if (!summary || summary.truncated || !Array.isArray(summary.refs) || typeof summary.text !== 'string') return { visibility: 'unknown', refs: [] };
  const expected = new Map(expectedRefs.map(ref => [ref.memoryId, ref.revision]));
  if (summary.refs.some(ref => expected.get(ref.memoryId) !== ref.revision)) return { visibility: 'unknown', refs: [] };
  return { visibility: 'visible', refs: summary.refs, evidence: false };
}
export function createMemoryContext({ store, clock = Date.now }) {
  return {
    async bindSession({ scopeId, sessionId }) {
      const scope = store.get('SELECT * FROM memory_scope WHERE id=?', scopeId);
      if (!scope) throw new MemoryError('NOT_FOUND', '会话范围不存在', 404);
      const old = store.get('SELECT * FROM context_checkpoint WHERE session_id=?', sessionId);
      if (old && old.scope_id !== scopeId) throw new MemoryError('SCOPE_DENIED', '会话与范围绑定不匹配', 403);
      if (!old) store.run('INSERT INTO context_checkpoint(session_id,scope_id,updated_at) VALUES(?,?,?)', sessionId, scopeId, clock());
      return { contextEpoch: old?.epoch || 1, generation: scope.generation };
    },
    /** 只接收宿主保存的 packet；模型或浏览器不能通过此接口伪造可见性。 */
    async confirmDelivery({ packet, sessionId, contextEpoch, generation }) {
      const scope = store.get('SELECT * FROM memory_scope WHERE id=?', packet.scopeId);
      const checkpoint = store.get('SELECT * FROM context_checkpoint WHERE session_id=?', sessionId);
      if (!scope || scope.barrier || scope.generation !== generation || packet.sourceGeneration !== generation || checkpoint?.scope_id !== scope.id || checkpoint.epoch !== contextEpoch) throw new MemoryError('STALE_GENERATION', '投递期间上下文已变化', 409);
      store.transaction(() => {
        for (const ref of packet.refs) {
          const current = store.get("SELECT current_revision FROM memory_item WHERE id=? AND scope_id=? AND status='active'", ref.memoryId, scope.id);
          if (current?.current_revision === ref.revision) store.run("INSERT INTO context_receipt VALUES(?,?,?,?,?) ON CONFLICT(session_id,epoch,memory_id) DO UPDATE SET revision=excluded.revision,visibility=excluded.visibility", sessionId, contextEpoch, ref.memoryId, ref.revision, 'visible');
        }
      });
    },
    async markUnknown({ sessionId }) {
      store.run("UPDATE context_receipt SET visibility='unknown' WHERE session_id=?", sessionId);
      store.run("UPDATE context_checkpoint SET visibility='unknown',updated_at=? WHERE session_id=?", clock(), sessionId);
    }
  };
}
