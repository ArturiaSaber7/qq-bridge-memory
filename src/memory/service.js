// 唯一记忆业务入口。HTTP、MCP 和后台任务共享来源、版本及范围校验。
import { randomUUID, createHash } from 'node:crypto';
import { MemoryError, requiredText, assertScope, requireAdmin, parseJson, KINDS, STATUSES } from './contracts.js';
import { resolveMemoryConfig } from './config.js';

/** 创建服务；store 仅在宿主工作线程持有。clock 注入用于可重复的时效/额度测试。 */
export function createMemoryService({ store, config = {}, clock = Date.now }) {
  const { run, get, all } = store;
  const settings = get('SELECT config FROM memory_settings WHERE id=1');
  let policy = resolveMemoryConfig(settings ? parseJson(settings.config, {}) : config);
  function scopeFor(actor, scopeId, { write = false, generation } = {}) {
    assertScope(actor, scopeId);
    const scope = get('SELECT * FROM memory_scope WHERE id=?', scopeId);
    if (!scope) throw new MemoryError('NOT_FOUND', '会话范围不存在', 404);
    if (generation !== undefined && scope.generation !== generation) throw new MemoryError('STALE_GENERATION', '会话代次已变化，请刷新', 409);
    if (write && scope.barrier) throw new MemoryError('ERASE_BARRIER', '记忆清除尚未完成，该范围已暂停', 409);
    return scope;
  }
  function sourceFor(actor, scopeId, sourceId) {
    scopeFor(actor, scopeId);
    const source = get('SELECT * FROM source_record WHERE id=? AND scope_id=?', sourceId, scopeId);
    if (!source) throw new MemoryError('SOURCE_MISSING', '来源不存在或不在当前范围', 400);
    return source;
  }
  function itemFor(actor, id) {
    const item = get('SELECT * FROM memory_item WHERE id=?', id);
    if (!item) throw new MemoryError('NOT_FOUND', '记忆不存在或已清除', 404);
    scopeFor(actor, item.scope_id);
    return item;
  }
  function detail(actor, id, revision) {
    const item = itemFor(actor, id);
    const rev = get('SELECT * FROM memory_revision WHERE memory_id=? AND revision=?', id, revision ?? item.current_revision);
    if (!rev) throw new MemoryError('NOT_FOUND', '版本不存在', 404);
    const evidence = all('SELECT s.*,e.stance FROM memory_evidence e JOIN source_record s ON s.id=e.source_id WHERE e.memory_id=? AND e.revision=?', id, rev.revision);
    return { id: item.id, scopeId: item.scope_id, kind: item.kind, status: item.status, mergedInto: item.merged_into,
      revision: rev.revision, currentRevision: item.current_revision, title: rev.title, body: rev.body,
      subjectIds: parseJson(rev.subject_ids, []), topics: parseJson(rev.topics, []), occurredAt: rev.occurred_at,
      validFrom: rev.valid_from, validTo: rev.valid_to, recordedAt: rev.recorded_at, sourceNature: rev.source_nature,
      reason: rev.reason, commitmentStatus: rev.commitment_status, evidence, createdAt: item.created_at, updatedAt: item.updated_at };
  }
  // 幂等摘要不保存正文副本；相同键不能悄悄用于另一个请求。
  function idempotent(scopeId, operation, input, work) {
    const key = requiredText(input.idempotencyKey, 'idempotencyKey', 200);
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
    const signature = createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
    const old = get('SELECT * FROM memory_idempotency WHERE scope_id=? AND operation=? AND key=?', scopeId, operation, key);
    if (old) {
      if (old.request_signature !== signature) throw new MemoryError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求', 409);
      return parseJson(old.result);
    }
    return store.transaction(() => {
      const result = work();
      run('INSERT INTO memory_idempotency VALUES(?,?,?,?,?)', scopeId, operation, key, signature, JSON.stringify(result));
      return result;
    });
  }
  function invalidate(scope, id, revision) {
    run('UPDATE memory_view SET dirty=1 WHERE scope_id=?', scope.id);
    run('INSERT INTO memory_outbox(scope_id,generation,kind,target_id,revision) VALUES(?,?,?,?,?)', scope.id, scope.generation, 'index', id, revision);
    // 依赖知识旧版本的结论必须先退出召回，不能仅重建 embedding。
    run("UPDATE memory_item SET status='needs_review' WHERE id IN (SELECT e.memory_id FROM memory_evidence e JOIN source_record s ON s.id=e.source_id WHERE s.kind='knowledge_revision' AND s.target_id=? AND s.target_revision<?) AND id<>?", id, revision, id);
  }
  function checkRevision(item, expected) {
    if (!Number.isSafeInteger(expected) || item.current_revision !== expected) throw new MemoryError('REVISION_CONFLICT', '记忆已被修改，请比较最新版本', 409, { currentRevision: item.current_revision });
  }
  function issue(scopeId, type, payload) {
    const id = randomUUID(), now = clock();
    run('INSERT INTO memory_issue(id,scope_id,type,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)', id, scopeId, type, JSON.stringify(payload), now, now);
    return id;
  }
  function writeItem(actor, input, existing) {
    const scope = scopeFor(actor, input.scopeId, { write: true, generation: input.scopeGeneration });
    if (actor.kind === 'agent' && existing) throw new MemoryError('SCOPE_DENIED', '模型通过提案更新，不能直接覆盖记忆', 403);
    if (existing) checkRevision(existing, input.expectedRevision);
    const kind = existing?.kind || input.kind;
    if (!KINDS.includes(kind)) throw new MemoryError('INVALID_INPUT', '记忆类型无效');
    const title = requiredText(input.title, 'title', 200), body = requiredText(input.body, 'body');
    const subjects = input.subjectIds || [];
    if (!Array.isArray(subjects) || subjects.length > 50 || subjects.some(id => !get('SELECT id FROM subject WHERE id=? AND scope_id=?', id, scope.id))) throw new MemoryError('INVALID_INPUT', '人物不属于当前会话');
    const sources = [...new Set(input.sourceIds || [])];
    if (!sources.length && actor.kind !== 'admin') throw new MemoryError('SOURCE_MISSING', '模型记忆必须有可验证来源');
    sources.forEach(id => sourceFor(actor, scope.id, id));
    const id = existing?.id || randomUUID(), revision = existing ? existing.current_revision + 1 : 1, now = clock();
    const commitmentStatus = kind === 'commitment' ? (input.commitmentStatus || 'pending') : null;
    if (commitmentStatus && !['pending', 'completed', 'cancelled'].includes(commitmentStatus)) throw new MemoryError('INVALID_INPUT', '约定状态无效');
    let nature = input.sourceNature || (actor.kind === 'admin' ? 'admin_assertion' : 'reported');
    if (!sources.length) {
      const sourceId = randomUUID();
      nature = kind === 'knowledge' ? 'knowledge_revision' : 'admin_assertion';
      run('INSERT INTO source_record(id,scope_id,kind,target_id,target_revision,actor,reason,recorded_at) VALUES(?,?,?,?,?,?,?,?)', sourceId, scope.id, nature, id, revision, 'local_admin', String(input.reason || '管理员录入'), now);
      sources.push(sourceId);
    }
    if (existing) run("UPDATE memory_item SET current_revision=?,updated_at=?,status='active' WHERE id=?", revision, now, id);
    else run('INSERT INTO memory_item(id,scope_id,kind,created_at,updated_at) VALUES(?,?,?,?,?)', id, scope.id, kind, now, now);
    run('INSERT INTO memory_revision(memory_id,revision,title,body,subject_ids,topics,occurred_at,valid_from,valid_to,recorded_at,source_nature,reason,commitment_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, revision, title, body, JSON.stringify(subjects), JSON.stringify((input.topics || []).map(String).slice(0, 30)),
      Number.isFinite(input.occurredAt) ? input.occurredAt : null, Number.isFinite(input.validFrom) ? input.validFrom : null,
      Number.isFinite(input.validTo) ? input.validTo : null, now, nature, String(input.reason || ''), commitmentStatus);
    for (const sourceId of sources) run('INSERT INTO memory_evidence(memory_id,revision,source_id) VALUES(?,?,?)', id, revision, sourceId);
    run("DELETE FROM memory_relation WHERE from_id=? AND type='link'", id);
    for (const match of body.matchAll(/\[\[([a-zA-Z0-9-]{1,80})(?:\|[^\]]*)?\]\]/g)) {
      if (match[1] !== id && get('SELECT id FROM memory_item WHERE id=? AND scope_id=?', match[1], scope.id))
        run('INSERT OR IGNORE INTO memory_relation(id,scope_id,from_id,to_id,type) VALUES(?,?,?,?,?)', randomUUID(), scope.id, id, match[1], 'link');
    }
    invalidate(scope, id, revision);
    return { memoryId: id, revision };
  }
  const api = {
    /** 账号和会话唯一；不依赖会被 reset 更换的 DSH sessionId。 */
    async ensureScope(actor, { ownerBotId, conversationKey }) {
      requireAdmin(actor);
      requiredText(ownerBotId, 'ownerBotId', 80);
      if (!/^(group|private):\d+$/.test(conversationKey)) throw new MemoryError('INVALID_INPUT', '会话标识无效');
      const existing = get('SELECT * FROM memory_scope WHERE owner_bot_id=? AND conversation_key=?', ownerBotId, conversationKey);
      if (existing) return existing;
      const id = randomUUID();
      run('INSERT INTO memory_scope(id,owner_bot_id,conversation_key) VALUES(?,?,?)', id, ownerBotId, conversationKey);
      return get('SELECT * FROM memory_scope WHERE id=?', id);
    },
    /** 截短前保存完整来源。平台 ID 缺失时保留两条，不以同文内容猜测重复。 */
    async captureMessage(actor, input) {
      const scope = scopeFor(actor, input.scopeId, { write: true, generation: input.generation });
      const direction = input.direction || 'inbound';
      if (!['inbound', 'outbound'].includes(direction)) throw new MemoryError('INVALID_INPUT', '消息方向无效');
      if (direction === 'outbound' && input.sentSuccessfully !== true) return { skipped: true };
      const senderId = requiredText(input.senderId, 'senderId', 80);
      const text = requiredText(input.text, 'text', 1000000);
      const platformId = input.platformMessageId == null ? null : requiredText(String(input.platformMessageId), 'platformMessageId', 120);
      if (platformId && get("SELECT 1 FROM memory_tombstone WHERE scope_id=? AND target_type='message' AND target_id=?", scope.id, platformId)) return { skipped: true, reason: 'erased' };
      const existing = platformId && get('SELECT s.id FROM source_record s JOIN message_event m ON m.id=s.target_id WHERE m.scope_id=? AND m.platform_message_id=?', scope.id, platformId);
      if (existing) return { sourceId: existing.id, duplicate: true };
      return store.transaction(() => {
        const now = clock(), messageId = randomUUID(), sourceId = randomUUID();
        const order = get('SELECT coalesce(max(source_order),0)+1 n FROM message_event').n;
        let subject = get('SELECT * FROM subject WHERE scope_id=? AND qq_id=?', scope.id, senderId);
        const name = String(input.senderName || senderId).slice(0, 200);
        if (!subject) {
          subject = { id: randomUUID() };
          run('INSERT INTO subject(id,scope_id,qq_id,name) VALUES(?,?,?,?)', subject.id, scope.id, senderId, name);
        } else run('UPDATE subject SET name=? WHERE id=?', name, subject.id);
        run('INSERT INTO subject_alias(subject_id,name,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(subject_id,name) DO UPDATE SET last_seen=excluded.last_seen', subject.id, name, now, now);
        run('INSERT INTO message_event(id,source_order,scope_id,platform_message_id,sender_id,sender_name,occurred_at,received_at,text,segments,quote_id,direction,sent_successfully) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          messageId, order, scope.id, platformId, senderId, name, Number.isFinite(input.occurredAt) ? input.occurredAt : null, Number.isFinite(input.receivedAt) ? input.receivedAt : now, text,
          JSON.stringify(input.segments || []), input.quoteId == null ? null : String(input.quoteId), direction, direction === 'outbound' ? 1 : 0);
        run('INSERT INTO source_record(id,scope_id,kind,target_id,recorded_at) VALUES(?,?,?,?,?)', sourceId, scope.id, 'platform_message', messageId, now);
        return { sourceId, messageId, subjectId: subject.id, duplicate: false };
      });
    },
    async createItem(actor, input) {
      scopeFor(actor, input.scopeId, { write: true, generation: input.scopeGeneration });
      return idempotent(input.scopeId, 'create', input, () => writeItem(actor, input));
    },
    async reviseItem(actor, input) {
      requireAdmin(actor);
      const item = itemFor(actor, input.memoryId);
      if (item.scope_id !== input.scopeId) throw new MemoryError('SCOPE_DENIED', '范围不匹配', 403);
      return idempotent(item.scope_id, 'revise', input, () => writeItem(actor, input, item));
    },
    async getItem(actor, { memoryId, revision }) { return detail(actor, memoryId, revision); },
    async listItems(actor, filter) {
      scopeFor(actor, filter.scopeId);
      const limit = Math.min(100, Math.max(1, Number(filter.limit) || 50));
      const filters = [filter.scopeId, filter.status || '', filter.kind || '', filter.query || '', filter.subjectId || ''];
      const signature = createHash('sha256').update(JSON.stringify(filters)).digest('hex');
      let after = 0, upper = get('SELECT coalesce(max(rowid),0) n FROM memory_item').n;
      if (filter.cursor) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(filter.cursor, 'base64url')); } catch { /* 统一返回游标错误 */ }
        if (!decoded || decoded.signature !== signature || !Number.isSafeInteger(decoded.after) || !Number.isSafeInteger(decoded.upper)) throw new MemoryError('INVALID_CURSOR', '筛选条件已变化，请重新查询');
        after = decoded.after; upper = decoded.upper;
      }
      const conditions = ['m.scope_id=?', 'm.rowid>?', 'm.rowid<=?'], params = [filter.scopeId, after, upper];
      if (filter.status) { conditions.push('m.status=?'); params.push(filter.status); }
      if (filter.kind) { conditions.push('m.kind=?'); params.push(filter.kind); }
      if (filter.query) { conditions.push('(instr(r.body,?)>0 OR instr(r.title,?)>0)'); params.push(filter.query, filter.query); }
      if (filter.subjectId) { conditions.push('EXISTS (SELECT 1 FROM json_each(r.subject_ids) WHERE value=?)'); params.push(filter.subjectId); }
      const rows = all(`SELECT m.id,m.rowid position FROM memory_item m JOIN memory_revision r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE ${conditions.join(' AND ')} ORDER BY m.rowid LIMIT ?`, ...params, limit + 1);
      const selected = rows.slice(0, limit);
      return { items: selected.map(row => detail(actor, row.id)), snapshot: String(upper), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ after: selected.at(-1).position, upper, signature })).toString('base64url') : null };
    },
    async setStatus(actor, input) {
      requireAdmin(actor);
      const item = itemFor(actor, input.memoryId);
      const scope = scopeFor(actor, item.scope_id, { write: true, generation: input.scopeGeneration });
      return idempotent(scope.id, 'status', input, () => {
        checkRevision(item, input.expectedRevision);
        if (!STATUSES.includes(input.status) || input.status === 'merged') throw new MemoryError('INVALID_INPUT', '状态无效，请通过合并操作合并');
        const previous = detail(actor, item.id);
        const result = writeItem(actor, { ...previous, ...input, scopeId: scope.id, title: previous.title, body: previous.body,
          sourceIds: previous.evidence.map(e => e.id) }, item);
        run('UPDATE memory_item SET status=? WHERE id=?', input.status, item.id);
        return result;
      });
    },
    async importLegacy(actor, { scopeId, snapshot }) {
      requireAdmin(actor); scopeFor(actor, scopeId);
      let imported = 0, unresolved = 0;
      for (const [name, value] of Object.entries(snapshot?.userImpressions || {})) {
        if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        const body = (Array.isArray(value.traits) ? value.traits : []).map(String).join('；');
        if (!body) continue;
        const key = createHash('sha256').update(name + '\n' + body).digest('hex');
        if (get("SELECT 1 FROM memory_idempotency WHERE scope_id=? AND operation='legacy' AND key=?", scopeId, key)) continue;
        idempotent(scopeId, 'legacy', { idempotencyKey: key }, () => {
          const matches = all('SELECT DISTINCT s.id FROM subject s JOIN subject_alias a ON s.id=a.subject_id WHERE s.scope_id=? AND a.name=?', scopeId, name);
          const sourceId = randomUUID();
          run('INSERT INTO source_record(id,scope_id,kind,actor,recorded_at) VALUES(?,?,?,?,?)', sourceId, scopeId, 'legacy_unverified', 'legacy', clock());
          const result = writeItem(actor, { scopeId, kind: 'impression', title: name, body, subjectIds: matches.length === 1 ? [matches[0].id] : [], sourceIds: [sourceId], sourceNature: 'legacy_unverified' });
          run("UPDATE memory_item SET status='needs_review' WHERE id=?", result.memoryId);
          issue(scopeId, matches.length === 1 ? 'legacy_review' : 'identity', { memoryIds: [result.memoryId], name });
          imported++; if (matches.length !== 1) unresolved++;
          return result;
        });
      }
      return { imported, unresolved };
    },
    /** 处置与实际业务变化同事务；仅改变 issue 的颜色不算处理完成。 */
    async resolveIssue(actor, input) {
      requireAdmin(actor);
      const row = get('SELECT * FROM memory_issue WHERE id=?', input.issueId);
      if (!row) throw new MemoryError('NOT_FOUND', '待处理项不存在', 404);
      scopeFor(actor, row.scope_id, { write: true });
      return idempotent(row.scope_id, 'issue', input, () => {
        if (row.revision !== input.issueRevision || row.status !== 'open') throw new MemoryError('REVISION_CONFLICT', '待处理项已变化', 409);
        requiredText(input.reason, 'reason', 2000);
        const payload = parseJson(row.payload, {});
        if (!['dismiss', 'bind_identity', 'detach_evidence', 'keep_disputed', 'accept'].includes(input.action)) throw new MemoryError('INVALID_INPUT', '不支持的处置');
        if (input.action !== 'dismiss') for (const id of payload.memoryIds || []) {
          const item = itemFor(actor, id); checkRevision(item, input.expectedRevisions?.[id]);
          const old = detail(actor, id);
          let sourceIds = old.evidence.map(e => e.id), subjectIds = old.subjectIds;
          if (input.action === 'bind_identity') {
            const subject = get('SELECT id FROM subject WHERE scope_id=? AND qq_id=?', row.scope_id, String(input.qqId));
            if (!subject) throw new MemoryError('INVALID_INPUT', '该 QQ 尚无可靠身份记录');
            subjectIds = [subject.id];
          }
          if (input.action === 'detach_evidence') sourceIds = sourceIds.filter(x => x !== input.sourceId);
          const changed = writeItem(actor, { ...old, scopeId: row.scope_id, expectedRevision: item.current_revision, reason: input.reason, sourceIds, subjectIds }, item);
          const status = input.action === 'keep_disputed' ? 'disputed' : (input.action === 'detach_evidence' && !sourceIds.length ? 'needs_review' : 'active');
          run('UPDATE memory_item SET status=? WHERE id=?', status, changed.memoryId);
        }
        run('UPDATE memory_issue SET status=?,revision=revision+1,reason=?,updated_at=? WHERE id=?', input.action === 'dismiss' ? 'dismissed' : 'resolved', input.reason, clock(), row.id);
        return { issueId: row.id, revision: row.revision + 1 };
      });
    },
    async close() { await store.close(); }
  };
  return api;
}
