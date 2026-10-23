import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
const f = await memoryFixture();
try {
  const a = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'group:123' });
  const b = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'private:456' });
  const text = '完整的中文长消息。'.repeat(100);
  const input = { scopeId: a.id, platformMessageId: '9007199254740993123', senderId: '456', senderName: '小明', text, direction: 'inbound', receivedAt: 1000 };
  const source = await f.service.captureMessage(admin, input);
  assert.equal(f.store.get('SELECT text FROM message_event').text, text);
  assert.equal((await f.service.captureMessage(admin, input)).duplicate, true);
  await f.service.captureMessage(admin, { ...input, platformMessageId: '2', senderName: '新昵称' });
  assert.equal(f.store.get('SELECT count(*) n FROM subject').n, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM subject_alias').n, 2);
  await f.service.captureMessage(admin, { ...input, platformMessageId: '3', senderId: '789' });
  assert.equal(f.store.get('SELECT count(*) n FROM subject').n, 2);
  await f.service.captureMessage(admin, { ...input, scopeId: b.id });
  assert.equal(f.store.get('SELECT count(*) n FROM message_event').n, 4);
  await assert.rejects(f.service.captureMessage({ kind: 'agent', scopeId: b.id }, input), { code: 'SCOPE_DENIED' });
  const failed = await f.service.captureMessage(admin, { ...input, platformMessageId: 'failed', direction: 'outbound', sentSuccessfully: false });
  assert.equal(failed.skipped, true);
  await f.service.captureMessage(admin, { ...input, platformMessageId: null });
  await f.service.captureMessage(admin, { ...input, platformMessageId: null });
  assert.equal(f.store.get('SELECT count(*) n FROM message_event').n, 6);
  assert.equal(f.store.get('SELECT kind FROM source_record WHERE id=?', source.sourceId).kind, 'platform_message');
  console.log('PASS memory capture: full source, replay, identity, scopes, actual sending');
} finally { await f.close(); }
