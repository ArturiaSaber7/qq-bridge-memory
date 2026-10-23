// 若来源授权、版本比较或失效传播被移除，这些业务断言必须失败。
import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
const f = await memoryFixture();
try {
  const scope = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'group:123' });
  const input = { scopeId: scope.id, scopeGeneration: 0, kind: 'knowledge', title: '中文知识', body: '参加活动需要提前报名', idempotencyKey: 'create-1' };
  const created = await f.service.createItem(admin, input);
  assert.equal((await f.service.createItem(admin, input)).memoryId, created.memoryId);
  await assert.rejects(f.service.createItem(admin, { ...input, body: '不同内容' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const item = await f.service.getItem(admin, { memoryId: created.memoryId });
  assert.equal(item.body, input.body);
  assert.equal(item.revision, 1);
  const edit = { ...input, memoryId: item.id, expectedRevision: 1, body: '报名已经截止', reason: '管理员更新', idempotencyKey: 'edit-1' };
  await f.service.reviseItem(admin, edit);
  await assert.rejects(f.service.reviseItem(admin, { ...edit, idempotencyKey: 'edit-2' }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.service.getItem(admin, { memoryId: item.id, revision: 1 })).body, input.body);
  const source = await f.service.captureMessage(admin, { scopeId: scope.id, senderId: '456', text: '我答应明天带资料', direction: 'inbound' });
  const promise = await f.service.createItem(admin, { ...input, kind: 'commitment', title: '明天带资料', body: '用户答应明天带资料', sourceIds: [source.sourceId], idempotencyKey: 'promise' });
  assert.equal((await f.service.getItem(admin, { memoryId: promise.memoryId })).commitmentStatus, 'pending');
  await assert.rejects(f.service.createItem({ kind: 'agent', scopeId: scope.id }, { ...input, sourceIds: [], idempotencyKey: 'fake' }), { code: 'SOURCE_MISSING' });
  await f.service.setStatus(admin, { scopeId: scope.id, memoryId: item.id, expectedRevision: 2, scopeGeneration: 0, status: 'inactive', reason: '停用', idempotencyKey: 'stop' });
  assert.equal((await f.service.getItem(admin, { memoryId: item.id })).status, 'inactive');
  assert.equal((await f.service.listItems(admin, { scopeId: scope.id, status: 'active' })).items.length, 1);
  const legacy = await f.service.importLegacy(admin, { scopeId: scope.id, snapshot: { userImpressions: { 未知昵称: { traits: ['爱看电影'] } } } });
  assert.equal(legacy.unresolved, 1);
  assert.equal((await f.service.importLegacy(admin, { scopeId: scope.id, snapshot: { userImpressions: { 未知昵称: { traits: ['爱看电影'] } } } })).imported, 0);
  const correction = await f.service.createItem(admin, { ...input, kind: 'reported_fact', title: '管理员修正', body: '用户已经搬家', reason: '手动确认', idempotencyKey: 'assertion' });
  const corrected = await f.service.getItem(admin, { memoryId: correction.memoryId });
  assert.equal(corrected.evidence[0].kind, 'admin_assertion');
  const issueId = f.store.all('SELECT id FROM memory_issue')[0].id;
  await f.service.resolveIssue(admin, { issueId, issueRevision: 1, action: 'dismiss', reason: '当前无法确认', expectedRevisions: {}, idempotencyKey: 'dismiss' });
  assert.equal(f.store.get('SELECT status FROM memory_issue WHERE id=?', issueId).status, 'dismissed');
  console.log('PASS memory service: versions, sources, conflicts, commitments, legacy, issues');
} finally { await f.close(); }
