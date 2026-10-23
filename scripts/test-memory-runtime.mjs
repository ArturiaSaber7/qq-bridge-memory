import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRuntime } from '../src/memory/runtime.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-'));
let runtime;
try {
  runtime = await createMemoryRuntime({ file: path.join(dir, 'memory.sqlite') });
  const actor = { kind: 'admin' };
  const scope = await runtime.ensureScope(actor, { ownerBotId: '1', conversationKey: 'group:2' });
  const item = await runtime.createItem(actor, { scopeId: scope.id, kind: 'knowledge', title: '喜欢咖啡', body: '管理员确认喜欢咖啡', idempotencyKey: 'worker' });
  assert.equal((await runtime.getItem(actor, { memoryId: item.memoryId })).title, '喜欢咖啡');
  const packet = await runtime.previewRecall(actor, { scopeId: scope.id, query: '咖啡' });
  assert.equal(packet.refs.length, 1);
  await assert.rejects(runtime.previewRecall({ kind: 'agent' }, { scopeId: scope.id, query: '咖啡' }), { code: 'SCOPE_DENIED' });
  console.log('memory worker: PASS');
} finally { await runtime?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
