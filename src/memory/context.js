// 回执只代表已接受的投递；压缩/重启无法证明保留内容时，必须回到 unknown。
import { MemoryError } from './contracts.js';
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
