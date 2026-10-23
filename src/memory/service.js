// 唯一记忆业务入口。HTTP、MCP 和后台任务共享来源、版本及范围校验。
import { randomUUID, createHash } from 'node:crypto';
import { MemoryError, requiredText, assertScope, requireAdmin, parseJson, KINDS, STATUSES } from './contracts.js';
import { resolveMemoryConfig } from './config.js';
import { detectMemoryContextCapabilities } from './context.js';

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
    let nature = actor.kind === 'admin' ? input.sourceNature || 'admin_assertion' : kind === 'impression' ? 'inferred' : 'reported';
    if (kind === 'commitment' && input.commitmentOwner === 'assistant' && !sources.some(sourceId => {
      const source = sourceFor(actor, scope.id, sourceId);
      return source.kind === 'platform_message' && get("SELECT 1 FROM message_event WHERE id=? AND direction='outbound' AND sent_successfully=1", source.target_id);
    })) throw new MemoryError('SOURCE_MISSING', '机器人约定必须有实际发送成功的来源');
    const previousRevision = existing ? get('SELECT title,body FROM memory_revision WHERE memory_id=? AND revision=?', id, existing.current_revision) : null;
    const adminCorrection = actor.kind === 'admin' && previousRevision && (previousRevision.title !== title || previousRevision.body !== body);
    if (!sources.length || (actor.kind === 'admin' && kind === 'knowledge') || adminCorrection) {
      const sourceId = randomUUID();
      nature = kind === 'knowledge' ? 'knowledge_revision' : 'admin_assertion';
      run('INSERT INTO source_record(id,scope_id,kind,target_id,target_revision,actor,reason,recorded_at) VALUES(?,?,?,?,?,?,?,?)', sourceId, scope.id, nature, id, revision, 'local_admin', String(input.reason || (existing ? '管理员修改' : '管理员录入')), now);
      sources.push(sourceId);
    }
    if (existing) run("UPDATE memory_item SET current_revision=?,updated_at=?,status='active' WHERE id=?", revision, now, id);
    else run('INSERT INTO memory_item(id,scope_id,kind,created_at,updated_at) VALUES(?,?,?,?,?)', id, scope.id, kind, now, now);
    run('INSERT INTO memory_revision(memory_id,revision,title,body,subject_ids,topics,occurred_at,valid_from,valid_to,recorded_at,source_nature,reason,commitment_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, revision, title, body, JSON.stringify(subjects), JSON.stringify((input.topics || []).map(String).slice(0, 30)),
      Number.isFinite(input.occurredAt) ? input.occurredAt : null, Number.isFinite(input.validFrom) ? input.validFrom : null,
      Number.isFinite(input.validTo) ? input.validTo : null, now, nature, String(input.reason || ''), commitmentStatus);
    for (const sourceId of sources) run('INSERT INTO memory_evidence(memory_id,revision,source_id) VALUES(?,?,?)', id, revision, sourceId);
    if (kind === 'commitment' && actor.kind !== 'admin') {
      const botSubject = get('SELECT id FROM subject WHERE scope_id=? AND qq_id=?', scope.id, scope.owner_bot_id);
      const hasSentSource = sources.some(sourceId => {
        const source = sourceFor(actor, scope.id, sourceId);
        return source.kind === 'platform_message' && get("SELECT 1 FROM message_event WHERE id=? AND direction='outbound' AND sent_successfully=1", source.target_id);
      });
      // 模型没有明确承诺主体时保留候选待核实，不能把群友的话自动算成机器人的承诺。
      if (!subjects.length || (subjects.includes(botSubject?.id) && !hasSentSource)) {
        run("UPDATE memory_item SET status='needs_review' WHERE id=?", id);
        issue(scope.id, 'commitment_attribution', { memoryIds: [id] });
      }
    }
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
        const order = get("UPDATE memory_sequence SET value=value+1 WHERE name='source' RETURNING value").value;
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
    async authorizeAgent(actor, { scopeId }) {
      const scope = scopeFor(actor, scopeId, { write: true });
      const overrides = parseJson(scope.policy, {});
      if (!policy.enabled || overrides.enabled === false || (overrides.mode || policy.mode) !== 'active') throw new MemoryError('MEMORY_DISABLED', '当前会话尚未启用长期记忆对话能力', 403);
      return { enabled: true, mode: 'active', generation: scope.generation };
    },
    async proposeItem(actor, input) {
      if (actor.kind === 'agent') await api.authorizeAgent(actor, { scopeId: input.scopeId });
      scopeFor(actor, input.scopeId, { write: true, generation: input.scopeGeneration });
      return idempotent(input.scopeId, 'propose', input, () => {
        const result = writeItem(actor, input);
        run("UPDATE memory_item SET status='needs_review' WHERE id=?", result.memoryId);
        return { ...result, issueId: issue(input.scopeId, 'proposal', { memoryIds: [result.memoryId] }), status: 'needs_review' };
      });
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
    async commitJobResult(actor, { jobId, generation, candidates, snapshot }) {
      const job = get('SELECT * FROM memory_job WHERE id=?', jobId);
      if (!job || actor.kind !== 'worker' || actor.scopeId !== job.scope_id) throw new MemoryError('SCOPE_DENIED', '无权提交后台结果', 403);
      const scope = scopeFor(actor, job.scope_id, { write: true, generation });
      if (job.status !== 'running' || job.lease_until < clock()) throw new MemoryError('STALE_GENERATION', '任务租约已失效', 409);
      return store.transaction(() => {
        for (const sourceId of snapshot.sourceIds) sourceFor(actor, scope.id, sourceId);
        let accepted = 0;
        for (const candidate of candidates) {
          if (!Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length || candidate.sourceIds.some(id => !snapshot.sourceIds.includes(id))) throw new MemoryError('SOURCE_MISSING', '候选引用了本批次以外的来源');
          let existing;
          if (candidate.action && candidate.action !== 'create') {
            if (!['revise', 'dispute'].includes(candidate.action)) throw new MemoryError('INVALID_INPUT', '未知候选动作');
            existing = itemFor(actor, candidate.memoryId);
            checkRevision(existing, snapshot.memoryRevisions?.[existing.id]);
          }
          // 同一来源、同一正文的重建结果不重复扩增记忆。
          if (!existing && all('SELECT m.id FROM memory_item m JOIN memory_revision r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.scope_id=? AND m.kind=? AND r.body=? AND m.status<>?', scope.id, candidate.kind, candidate.body, 'merged').some(row => {
            const previous = detail(actor, row.id);
            return JSON.stringify(previous.evidence.map(e=>e.id).sort()) === JSON.stringify([...candidate.sourceIds].sort()) && JSON.stringify([...previous.subjectIds].sort()) === JSON.stringify([...(candidate.subjectIds || [])].sort());
          })) continue;
          const result = writeItem(actor, { ...candidate, expectedRevision: existing?.current_revision, scopeId: scope.id, scopeGeneration: generation }, existing);
          if (candidate.action === 'dispute') {
            run("UPDATE memory_item SET status='disputed' WHERE id=?", result.memoryId);
            issue(scope.id, 'conflict', { memoryIds: [result.memoryId], previousRevision: result.revision - 1 });
          }
          accepted++;
        }
        if (snapshot.advancesCursor !== false) run('INSERT INTO memory_cursor(scope_id,last_source_order,last_run_at,source_offset) VALUES(?,?,?,?) ON CONFLICT(scope_id) DO UPDATE SET last_source_order=excluded.last_source_order,last_run_at=excluded.last_run_at,source_offset=excluded.source_offset', scope.id, snapshot.throughOrder, clock(), snapshot.sourceOffset || 0);
        const previous = parseJson(job.result, {}) || {};
        run('UPDATE memory_job SET status=?,result=?,input_snapshot=NULL,updated_at=? WHERE id=?', snapshot.complete === false ? 'queued' : 'succeeded',
          JSON.stringify({ accepted: (previous.accepted || 0) + accepted, last_source_order: snapshot.throughOrder, source_offset: snapshot.sourceOffset || 0, sourceUpper: snapshot.sourceUpper }), clock(), jobId);
        return { accepted };
      });
    },
    getConfig() { return structuredClone(policy); },
    async getPolicy(actor, { scopeId } = {}) {
      requireAdmin(actor);
      if (scopeId) {
        const scope = scopeFor(actor, scopeId), overrides = parseJson(scope.policy, {});
        return { scopeId, revision: scope.revision, config: { ...structuredClone(policy), enabled: policy.enabled && overrides.enabled !== false, mode: overrides.mode || policy.mode }, overrides, globalEnabled: policy.enabled };
      }
      return { config: structuredClone(policy), revision: get('SELECT revision FROM memory_settings WHERE id=1')?.revision || 0 };
    },
    async updatePolicy(actor, { scopeId, expectedRevision, config: next }) {
      requireAdmin(actor);
      if (scopeId) {
        const scope = scopeFor(actor, scopeId, { write: true });
        if (scope.revision !== expectedRevision) throw new MemoryError('REVISION_CONFLICT', '会话策略已变化', 409);
        const resolved = resolveMemoryConfig(next);
        run('UPDATE memory_scope SET policy=?,revision=revision+1 WHERE id=?', JSON.stringify({ enabled: resolved.enabled, mode: resolved.mode }), scopeId);
        return api.getPolicy(actor, { scopeId });
      }
      const old = get('SELECT revision FROM memory_settings WHERE id=1')?.revision || 0;
      if (expectedRevision !== old) throw new MemoryError('REVISION_CONFLICT', '策略已变化，请刷新', 409);
      const merged = { ...policy, ...next };
      for (const group of ['recall', 'consolidation', 'reflection', 'budget']) merged[group] = { ...policy[group], ...next?.[group] };
      const resolved = resolveMemoryConfig(merged);
      // 数据库路径只能在启动配置中改变，运行中更新策略不能切换到另一个库。
      resolved.storage = policy.storage;
      run('INSERT INTO memory_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config', old + 1, JSON.stringify(resolved));
      policy = resolved;
      return { config: structuredClone(policy), revision: old + 1 };
    },
    async getEvidence(actor, { scopeId, sourceIds }) {
      if (actor.kind === 'agent') await api.authorizeAgent(actor, { scopeId });
      scopeFor(actor, scopeId);
      if (!Array.isArray(sourceIds) || sourceIds.length > 20) throw new MemoryError('INVALID_INPUT', '一次最多查询20个来源');
      return sourceIds.map(id => {
        const source = sourceFor(actor, scopeId, id);
        const message = source.kind === 'platform_message' ? get('SELECT * FROM message_event WHERE id=? AND scope_id=?', source.target_id, scopeId) : null;
        return { ...source, message, missing: source.kind === 'platform_message' && !message };
      });
    },
    /** 控制台查询集中校验；列表不能绕过范围检查访问任意数据库表。 */
    async readResource(actor, { resource, scopeId, id, ...filter }) {
      requireAdmin(actor);
      if (resource === 'overview') {
        return { scopes: all('SELECT * FROM memory_scope ORDER BY conversation_key'), config: structuredClone(policy),
          counts: { items: get('SELECT count(*) n FROM memory_item').n, issues: get("SELECT count(*) n FROM memory_issue WHERE status='open'").n, jobs: get("SELECT count(*) n FROM memory_job WHERE status IN ('queued','running')").n }, capabilities: { sqlite: true, lexical: 'chinese-ngram', vector: 'unavailable', context: 'native-compaction/visibility-unknown' } };
      }
      if (resource === 'revisions' || resource === 'evidence' || resource === 'relations') {
        const item = itemFor(actor, id); scopeId = item.scope_id;
        if (resource === 'revisions') return all('SELECT revision,recorded_at,reason FROM memory_revision WHERE memory_id=? ORDER BY revision DESC', id).map(row => detail(actor, id, row.revision));
        if (resource === 'evidence') return api.getEvidence(actor, { scopeId, sourceIds: detail(actor, id).evidence.map(e => e.id).slice(0, 20) });
        return all('SELECT * FROM memory_relation WHERE scope_id=? AND (from_id=? OR to_id=?) AND active=1 LIMIT 100', scopeId, id, id);
      }
      if (['job', 'issue', 'operation'].includes(resource)) {
        const tables = { job: 'memory_job', issue: 'memory_issue', operation: 'memory_operation' };
        const row = get(`SELECT * FROM ${tables[resource]} WHERE id=?`, id);
        if (!row) throw new MemoryError('NOT_FOUND', '记录不存在', 404);
        scopeFor(actor, row.scope_id);
        return { ...row, payload: parseJson(row.payload), plan: parseJson(row.plan), result: parseJson(row.result) };
      }
      scopeFor(actor, scopeId);
      const limit = Math.min(100, Math.max(1, Number(filter.limit) || 50));
      if (resource === 'subjects') return all('SELECT * FROM subject WHERE scope_id=? ORDER BY name LIMIT ?', scopeId, limit);
      if (resource === 'subject') {
        const person = get('SELECT * FROM subject WHERE scope_id=? AND id=?', scopeId, id);
        if (!person) throw new MemoryError('NOT_FOUND', '人物不存在', 404);
        return { ...person, aliases: all('SELECT * FROM subject_alias WHERE subject_id=?', id), memories: await api.listItems(actor, { scopeId, subjectId: id }) };
      }
      if (resource === 'messages') return all('SELECT m.*,s.id source_id FROM message_event m JOIN source_record s ON s.target_id=m.id WHERE m.scope_id=? AND m.source_order>? ORDER BY m.source_order LIMIT ?', scopeId, Number(filter.after) || 0, limit);
      if (resource === 'context-status') return { sessions: all('SELECT * FROM context_checkpoint WHERE scope_id=?', scopeId), ...detectMemoryContextCapabilities() };
      const tables = { jobs: 'memory_job', issues: 'memory_issue', views: 'console_saved_view', operations: 'memory_operation' };
      if (tables[resource]) return all(`SELECT * FROM ${tables[resource]} WHERE scope_id=? LIMIT ?`, scopeId, limit).map(row => ({ ...row, payload: parseJson(row.payload), data: parseJson(row.data), result: parseJson(row.result) }));
      if (resource === 'graph') {
        const first = id ? itemFor(actor, id) : get('SELECT * FROM memory_item WHERE scope_id=? ORDER BY created_at DESC LIMIT 1', scopeId);
        if (!first) return { nodes: [], edges: [], truncated: false };
        if (first.scope_id !== scopeId) throw new MemoryError('SCOPE_DENIED', '节点不在此范围', 403);
        const edges = all('SELECT * FROM memory_relation WHERE scope_id=? AND (from_id=? OR to_id=?) AND active=1 LIMIT 100', scopeId, first.id, first.id);
        const ids = [...new Set([first.id, ...edges.flatMap(e => [e.from_id, e.to_id])])].slice(0, 100);
        return { nodes: ids.map(key => detail(actor, key)), edges: edges.filter(e => ids.includes(e.from_id) && ids.includes(e.to_id)), truncated: edges.length === 100 };
      }
      throw new MemoryError('NOT_FOUND', '未知查询', 404);
    },
    async saveView(actor, { scopeId, id, name, data, expectedRevision }) {
      requireAdmin(actor); scopeFor(actor, scopeId);
      requiredText(name, 'name', 100);
      const content = JSON.stringify(data || {});
      if (content.length > 10000) throw new MemoryError('INVALID_INPUT', '保存视图过大');
      const old = id ? get('SELECT * FROM console_saved_view WHERE id=? AND scope_id=?', id, scopeId) : null;
      if (id && (!old || old.revision !== expectedRevision)) throw new MemoryError('REVISION_CONFLICT', '视图已变化', 409);
      const viewId = id || randomUUID(), revision = (old?.revision || 0) + 1;
      run('INSERT INTO console_saved_view VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,revision=excluded.revision', viewId, scopeId, name, content, revision);
      return { id: viewId, revision };
    },
    /** 预览仅返回标识与版本；提交重新读取来源，不能相信浏览器提供的证据。 */
    async previewMerge(actor, { scopeId, memoryIds, targetId }) {
      requireAdmin(actor);
      const scope = scopeFor(actor, scopeId, { write: true });
      if (!Array.isArray(memoryIds) || memoryIds.length < 2 || memoryIds.length > 20 || new Set(memoryIds).size !== memoryIds.length || !memoryIds.includes(targetId)) throw new MemoryError('INVALID_INPUT', '请选择2至20条不同记忆和其中的目标');
      const revisions = {};
      for (const id of memoryIds) {
        const item = itemFor(actor, id);
        if (item.scope_id !== scopeId) throw new MemoryError('SCOPE_DENIED', '只能合并同一会话的记忆', 403);
        if (item.status === 'merged') throw new MemoryError('INVALID_INPUT', '已合并的记忆不能再次作为输入');
        revisions[id] = item.current_revision;
      }
      return { scopeId, generation: scope.generation, memoryIds, targetId, revisions };
    },
    async commitMerge(actor, input) {
      requireAdmin(actor);
      const plan = input.plan || {};
      const scope = scopeFor(actor, plan.scopeId, { write: true, generation: plan.generation });
      return idempotent(scope.id, 'merge', input, () => {
        if (!Array.isArray(plan.memoryIds) || plan.memoryIds.length < 2 || plan.memoryIds.length > 20 || new Set(plan.memoryIds).size !== plan.memoryIds.length || !plan.memoryIds.includes(plan.targetId)) throw new MemoryError('INVALID_INPUT', '合并预览无效');
        const items = plan.memoryIds.map(id => {
          const item = itemFor(actor, id);
          if (item.scope_id !== scope.id) throw new MemoryError('SCOPE_DENIED', '范围不匹配', 403);
          checkRevision(item, plan.revisions?.[id]);
          if (item.status === 'merged') throw new MemoryError('REVISION_CONFLICT', '记忆已合并', 409);
          return detail(actor, id);
        });
        const target = itemFor(actor, plan.targetId);
        requiredText(input.reason, 'reason', 2000);
        const result = writeItem(actor, { scopeId: scope.id, expectedRevision: target.current_revision,
          title: input.title, body: input.body, reason: input.reason,
          subjectIds: [...new Set(items.flatMap(x => x.subjectIds))], topics: [...new Set(items.flatMap(x => x.topics))],
          sourceIds: [...new Set(items.flatMap(x => x.evidence.map(e => e.id)))] }, target);
        for (const item of items) if (item.id !== target.id) {
          // 历史正文保留，当前状态退出召回；索引通过同一 outbox 事务失效。
          run("UPDATE memory_item SET status='merged',merged_into=?,updated_at=? WHERE id=?", target.id, clock(), item.id);
          invalidate(scope, item.id, item.revision);
        }
        return result;
      });
    },
    /** 清除来源的所有引用与知识派生闭包；预览不保存任何待清除正文。 */
    async previewErase(actor, { scopeId, memoryIds }) {
      requireAdmin(actor);
      const scope = scopeFor(actor, scopeId, { write: true });
      if (!Array.isArray(memoryIds) || !memoryIds.length || memoryIds.length > 100) throw new MemoryError('INVALID_INPUT', '请选择1至100条记忆');
      const ids = new Set(memoryIds), sources = new Set();
      let changed = true;
      while (changed) {
        const previous = ids.size + sources.size;
        for (const id of ids) {
          const item = itemFor(actor, id);
          if (item.scope_id !== scopeId) throw new MemoryError('SCOPE_DENIED', '范围不匹配', 403);
          for (const row of all('SELECT source_id FROM memory_evidence WHERE memory_id=?', id)) sources.add(row.source_id);
          for (const row of all('SELECT id FROM source_record WHERE scope_id=? AND target_id=?', scopeId, id)) sources.add(row.id);
        }
        for (const id of sources) for (const row of all('SELECT DISTINCT memory_id FROM memory_evidence WHERE source_id=?', id)) ids.add(row.memory_id);
        changed = previous !== ids.size + sources.size;
      }
      return { scopeId, generation: scope.generation, selectedIds: [...new Set(memoryIds)].sort(), memoryIds: [...ids].sort(), sourceIds: [...sources].sort(),
        revisions: Object.fromEntries([...ids].sort().map(id => [id, itemFor(actor, id).current_revision])),
        resetsConversationContext: true, clearsDerivedViews: true, remoteHistory: 'unknown' };
    },
    async commitErase(actor, input) {
      requireAdmin(actor);
      const plan = input.plan || {};
      scopeFor(actor, plan.scopeId);
      if (get("SELECT 1 FROM memory_idempotency WHERE scope_id=? AND operation='erase' AND key=?", plan.scopeId, input.idempotencyKey)) {
        const prior = idempotent(plan.scopeId, 'erase', input, () => null);
        return { ...prior, status: get('SELECT status FROM memory_operation WHERE id=?', prior.operationId)?.status || prior.status };
      }
      const fresh = await api.previewErase(actor, { scopeId: plan.scopeId, memoryIds: plan.selectedIds });
      if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new MemoryError('REVISION_CONFLICT', '清除范围或版本已变化，请重新预览', 409);
      requiredText(input.reason, 'reason', 2000);
      return idempotent(plan.scopeId, 'erase', input, () => {
        const generation = plan.generation + 1, now = clock(), operationId = randomUUID();
        run('UPDATE memory_scope SET barrier=1,generation=? WHERE id=?', generation, plan.scopeId);
        run("UPDATE memory_job SET status='cancelled',input_snapshot=NULL,result=NULL,error=NULL,updated_at=? WHERE scope_id=?", now, plan.scopeId);
        run('DELETE FROM memory_fts WHERE scope_id=?', plan.scopeId);
        run('DELETE FROM memory_view WHERE scope_id=?', plan.scopeId);
        run('DELETE FROM context_checkpoint WHERE scope_id=?', plan.scopeId);
        // 派生的 issue、保存视图可能包含原文片段，按会话清理，避免侧表残留。
        run('DELETE FROM memory_issue WHERE scope_id=?', plan.scopeId);
        run('DELETE FROM console_saved_view WHERE scope_id=?', plan.scopeId);
        run('DELETE FROM memory_outbox WHERE scope_id=?', plan.scopeId);
        run('UPDATE memory_cursor SET source_offset=0 WHERE scope_id=?', plan.scopeId);
        for (const id of plan.memoryIds) {
          run('INSERT OR IGNORE INTO memory_tombstone VALUES(?,?,?,?,?)', plan.scopeId, 'memory', id, generation, now);
          run('DELETE FROM memory_item WHERE id=?', id);
        }
        for (const id of plan.sourceIds) {
          const source = sourceFor(actor, plan.scopeId, id);
          run('DELETE FROM memory_relation WHERE source_id=?', id);
          if (source.kind === 'platform_message') {
            const message = get('SELECT * FROM message_event WHERE id=?', source.target_id);
            if (message?.platform_message_id) run('INSERT OR IGNORE INTO memory_tombstone VALUES(?,?,?,?,?)', plan.scopeId, 'message', message.platform_message_id, generation, now);
            run('DELETE FROM message_event WHERE id=?', source.target_id);
          }
          run('DELETE FROM source_record WHERE id=?', id);
        }
        // 清理整个索引后，为未清除条目补建当前代次任务，否则剩余记忆会永久失去召回。
        run("INSERT INTO memory_outbox(scope_id,generation,kind,target_id,revision) SELECT scope_id,?,'index',id,current_revision FROM memory_item WHERE scope_id=?", generation, plan.scopeId);
        // 不删除人物的稳定 QQ 标识，但清除可能来自已删除原文的别名。
        run('DELETE FROM subject_alias WHERE subject_id IN (SELECT id FROM subject WHERE scope_id=?)', plan.scopeId);
        run('UPDATE subject SET name=qq_id WHERE scope_id=?', plan.scopeId);
        run('INSERT INTO memory_operation(id,scope_id,type,status,generation,plan,created_at) VALUES(?,?,?,?,?,?,?)', operationId, plan.scopeId, 'erase', 'pending_context', generation, JSON.stringify(plan), now);
        return { operationId, scopeId: plan.scopeId, generation, status: 'pending_context' };
      });
    },
    /** 仅宿主确认旧会话已隔离后释放写屏障；远程日志无法证实清除，明确保留 unknown。 */
    async completeErase(actor, { operationId, generation, contextRetired }) {
      const operation = get('SELECT * FROM memory_operation WHERE id=?', operationId);
      if (!operation || actor.kind !== 'worker' || actor.scopeId !== operation.scope_id) throw new MemoryError('SCOPE_DENIED', '无权完成清除', 403);
      scopeFor(actor, operation.scope_id, { generation });
      if (contextRetired !== true || operation.generation !== generation) throw new MemoryError('ERASE_BARRIER', '旧会话尚未隔离', 409);
      return store.transaction(() => {
        run("UPDATE memory_operation SET status='succeeded',result=? WHERE id=?", JSON.stringify({ local: 'erased', context: 'retired', remoteHistory: 'unknown' }), operationId);
        run('UPDATE memory_scope SET barrier=0 WHERE id=?', operation.scope_id);
        return { operationId, status: 'succeeded', remoteHistory: 'unknown' };
      });
    },
    async close() { await store.close(); }
  };
  return api;
}
