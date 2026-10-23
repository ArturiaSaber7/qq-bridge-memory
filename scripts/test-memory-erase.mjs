import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
const f = await memoryFixture();
try {
  const scope = await f.service.ensureScope(admin, { ownerBotId: '1', conversationKey: 'private:2' });
  const input = { scopeId: scope.id, senderId: '2', text: '需要遗忘的原文', platformMessageId: '100' };
  const source = await f.service.captureMessage(admin, input);
  const oldOrder = f.store.get('SELECT source_order FROM message_event').source_order;
  const a = await f.service.createItem(admin, { scopeId: scope.id, kind: 'reported_fact', title: '事实', body: input.text, sourceIds: [source.sourceId], idempotencyKey: 'a' });
  const b = await f.service.createItem(admin, { scopeId: scope.id, kind: 'impression', title: '派生印象', body: '来源相同', sourceIds: [source.sourceId], idempotencyKey: 'b' });
  const plan = await f.service.previewErase(admin, { scopeId: scope.id, memoryIds: [a.memoryId] });
  assert.deepEqual(new Set(plan.memoryIds), new Set([a.memoryId, b.memoryId]));
  const operation = await f.service.commitErase(admin, { plan, idempotencyKey: 'erase', reason: '删除测试' });
  assert.equal(operation.status, 'pending_context');
  await assert.rejects(f.service.captureMessage(admin, { ...input, platformMessageId: '101' }), { code: 'ERASE_BARRIER' });
  assert.equal(f.store.get('SELECT count(*) n FROM memory_revision').n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM message_event').n, 0);
  await f.service.completeErase({ kind: 'worker', scopeId: scope.id }, { operationId: operation.operationId, generation: 1, contextRetired: true });
  assert.equal((await f.service.captureMessage(admin, input)).reason, 'erased');
  await f.service.captureMessage(admin, { ...input, platformMessageId: '101' });
  assert.ok(f.store.get('SELECT source_order FROM message_event').source_order > oldOrder);
  console.log('memory erase: PASS');
} finally { await f.close(); }
