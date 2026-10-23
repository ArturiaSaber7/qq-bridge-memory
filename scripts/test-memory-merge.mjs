import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
const f = await memoryFixture();
try {
  const scope = await f.service.ensureScope(admin, { ownerBotId: '1', conversationKey: 'private:2' });
  const create = title => f.service.createItem(admin, { scopeId: scope.id, kind: 'knowledge', title, body: title, idempotencyKey: title });
  const a = await create('偏好甲'), b = await create('偏好乙');
  const plan = await f.service.previewMerge(admin, { scopeId: scope.id, memoryIds: [a.memoryId, b.memoryId], targetId: a.memoryId });
  await assert.rejects(f.service.commitMerge({ kind: 'agent', scopeId: scope.id }, { plan, idempotencyKey: 'deny' }), { code: 'SCOPE_DENIED' });
  const result = await f.service.commitMerge(admin, { plan, title: '合并偏好', body: '甲和乙', reason: '管理员核对', idempotencyKey: 'merge' });
  const merged = await f.service.getItem(admin, { memoryId: a.memoryId });
  assert.equal(merged.revision, 2);
  assert.equal(merged.evidence.length, 2);
  assert.equal((await f.service.getItem(admin, { memoryId: b.memoryId })).status, 'merged');
  assert.deepEqual(await f.service.commitMerge(admin, { plan, title: '合并偏好', body: '甲和乙', reason: '管理员核对', idempotencyKey: 'merge' }), result);
  await assert.rejects(f.service.commitMerge(admin, { plan, title: '旧预览', body: '旧预览', reason: '旧预览', idempotencyKey: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.service.getItem(admin, { memoryId: b.memoryId, revision: 1 })).body, '偏好乙');
  console.log('memory merge: PASS');
} finally { await f.close(); }
