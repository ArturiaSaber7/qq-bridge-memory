import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
import { createMemoryIndexes } from '../src/memory/indexes.js';
import { createMemoryRecall } from '../src/memory/recall.js';
import { createMemoryContext } from '../src/memory/context.js';
const f = await memoryFixture();
try {
  const a = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'group:123' });
  const b = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'private:456' });
  for (let n = 0; n < 8; n++) await f.service.createItem(admin, { scopeId: a.id, kind: 'knowledge', title: `钓鱼活动${n}`, body: '钓鱼活动需要报名', idempotencyKey: `a${n}` });
  await f.service.createItem(admin, { scopeId: b.id, kind: 'knowledge', title: '钓鱼私聊', body: '秘密钓鱼地点', idempotencyKey: 'b' });
  const indexes = createMemoryIndexes({ store: f.store });
  const context = createMemoryContext({ store: f.store });
  // 固定计数器隔离「6 条上限」；默认字节上界另测，不能假定 800 总能容纳六条。
  const recall = createMemoryRecall({ store: f.store, indexes, tokenCounter: { count: text => ({ count: Math.ceil(text.length / 4) }) } });
  const bound = await context.bindSession({ scopeId: a.id, sessionId: 'session-a' });
  const query = { scopeId: a.id, generation: 0, query: '钓鱼', sessionId: 'session-a', contextEpoch: bound.contextEpoch };
  const packet = await recall.buildPacket(query);
  assert.equal(packet.refs.length, 6);
  assert.ok(packet.tokenCount <= 800);
  const conservative = await createMemoryRecall({ store: f.store, indexes }).buildPacket(query);
  assert.ok(conservative.tokenCount <= 800 && conservative.refs.length <= 6);
  assert.ok(!packet.text.includes('秘密'));
  assert.equal((await recall.buildPacket({ ...query, query: '宇宙飞船' })).refs.length, 0);
  await context.confirmDelivery({ packet, sessionId: 'session-a', contextEpoch: bound.contextEpoch, generation: 0 });
  assert.equal((await recall.buildPacket(query)).refs.length, 2);
  await context.markUnknown({ sessionId: 'session-a', reason: 'compaction' });
  assert.equal((await recall.buildPacket(query)).refs.length, 6);
  assert.equal((await recall.buildPacket({ ...query, visibilityMode: 'fresh' })).refs.length, 6);
  assert.equal(f.store.get("SELECT count(*) n FROM context_receipt WHERE visibility='visible'").n, 0);
  const first = packet.refs[0];
  await f.service.setStatus(admin, { memoryId: first.memoryId, expectedRevision: first.revision, status: 'inactive', idempotencyKey: 'off' });
  assert.ok(!(await recall.buildPacket(query)).refs.some(r => r.memoryId === first.memoryId));
  f.store.run('UPDATE memory_scope SET generation=1 WHERE id=?', a.id);
  await assert.rejects(recall.buildPacket(query), { code: 'STALE_GENERATION' });
  console.log('PASS memory recall: Chinese search, isolation, budgets, visibility, stale revisions');
} finally { await f.close(); }
