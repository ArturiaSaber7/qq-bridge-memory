// 召回结果经范围/版本复验后打包；相似度不是可信度，也不因被召回增加证据。
import { randomUUID } from 'node:crypto';
import { MemoryError, parseJson } from './contracts.js';
import { resolveMemoryConfig } from './config.js';
export function createMemoryRecall({ store, indexes, getConfig = () => resolveMemoryConfig({}), tokenCounter, clock = Date.now }) {
  const count = text => tokenCounter ? tokenCounter.count(text).count : Buffer.byteLength(text, 'utf8');
  return {
    async buildPacket(request) {
      const scope = store.get('SELECT * FROM memory_scope WHERE id=?', request.scopeId);
      if (!scope) throw new MemoryError('NOT_FOUND', '会话不存在', 404);
      if (scope.barrier) throw new MemoryError('ERASE_BARRIER', '记忆清除尚未完成', 409);
      if (request.generation !== scope.generation) throw new MemoryError('STALE_GENERATION', '召回范围已变化', 409);
      const config = getConfig().recall;
      const candidates = await indexes.search({ scopeId: scope.id, query: String(request.query || ''), limits: { lexical: config.lexicalCandidates, vector: config.vectorCandidates } });
      const scores = new Map();
      for (const list of [candidates.lexical, candidates.vector]) list.forEach((row, rank) => scores.set(row.id, (scores.get(row.id) || 0) + 1 / (60 + rank + 1)));
      // 只扩一跳，并在权威读取点再次检查范围；不信任向量适配器返回的 ID。
      for (const id of [...scores.keys()]) for (const edge of store.all('SELECT to_id FROM memory_relation WHERE scope_id=? AND from_id=? AND active=1 LIMIT 10', scope.id, id)) {
        if (!scores.has(edge.to_id)) scores.set(edge.to_id, (scores.get(id) || 0) / 2);
      }
      const refs = [], sections = [], excludedReasons = [];
      const maximum = request.mode === 'deep' ? config.deepMaxTokens : config.normalMaxTokens;
      const itemLimit = request.mode === 'deep' ? 30 : config.normalMaxItems;
      for (const [id] of [...scores].sort((a, b) => b[1] - a[1])) {
        const item = store.get('SELECT m.*,r.* FROM memory_item m JOIN memory_revision r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.id=? AND m.scope_id=?', id, scope.id);
        let reason;
        if (!item || item.status !== 'active') reason = 'inactive_or_out_of_scope';
        else if (item.valid_to !== null && item.valid_to < clock()) reason = 'expired';
        else if (request.subjectIds?.length && !request.subjectIds.some(s => parseJson(item.subject_ids, []).includes(s))) reason = 'subject';
        else if (request.visibilityMode !== 'fresh' && request.sessionId && store.get("SELECT 1 FROM context_receipt WHERE session_id=? AND epoch=? AND memory_id=? AND revision=? AND visibility='visible'", request.sessionId, request.contextEpoch || 1, id, item.revision)) reason = 'already_visible';
        if (reason) { excludedReasons.push({ memoryId: id, reason }); continue; }
        const evidence = store.all('SELECT s.id,s.kind FROM memory_evidence e JOIN source_record s ON s.id=e.source_id WHERE e.memory_id=? AND e.revision=? AND s.scope_id=?', id, item.revision, scope.id);
        if (!evidence.length || evidence.every(e => e.kind === 'legacy_unverified')) { excludedReasons.push({ memoryId: id, reason: 'unverified_source' }); continue; }
        const sourceIds = evidence.map(e => e.id);
        const label = evidence.some(e => e.kind === 'admin_assertion') ? '管理员记录' : item.source_nature;
        const section = `[${id}@${item.revision} ${item.kind} ${label}] ${item.title}\n${item.body}\n来源：${sourceIds.join(',')}`;
        if (refs.length >= itemLimit || count([...sections, section].join('\n\n')) > maximum) { excludedReasons.push({ memoryId: id, reason: 'budget' }); continue; }
        sections.push(section); refs.push({ memoryId: id, revision: item.revision, sourceIds });
      }
      // 异步向量检索期间可能发生清除，再检查代次，拒绝晚到的旧结果。
      const latest = store.get('SELECT generation,barrier FROM memory_scope WHERE id=?', scope.id);
      if (latest.generation !== scope.generation || latest.barrier) throw new MemoryError('STALE_GENERATION', '检索期间范围已变化', 409);
      const text = sections.join('\n\n');
      return { packetId: randomUUID(), scopeId: scope.id, text, refs, tokenCount: count(text), countMethod: tokenCounter ? 'tokenizer' : 'utf8_upper_bound', truncated: excludedReasons.some(x => x.reason === 'budget'), excludedReasons, coverage: candidates.coverage, sourceGeneration: scope.generation };
    }
  };
}
