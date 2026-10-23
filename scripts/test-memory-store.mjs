// 真实 SQLite 回归：约束遗漏、事务中途失败和重复启动不能破坏持久记忆。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryStore } from '../src/memory/store.js';
import { resolveMemoryConfig } from '../src/memory/config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-store-'));
const file = path.join(dir, 'memory.sqlite');
let store;
try {
  assert.equal(resolveMemoryConfig({}).enabled, false);
  assert.throws(() => resolveMemoryConfig({ mode: 'unsafe' }), /mode/);
  assert.throws(() => resolveMemoryConfig({ recall: { normalMaxTokens: -1 } }), /normalMaxTokens/);
  store = await openMemoryStore({ file });
  store.run('INSERT INTO memory_scope(id,owner_bot_id,conversation_key) VALUES(?,?,?)', 's1', '9007199254740993123', 'group:123');
  assert.equal(store.get('SELECT owner_bot_id FROM memory_scope WHERE id=?', 's1').owner_bot_id, '9007199254740993123');
  assert.throws(() => store.run('INSERT INTO memory_scope(id,owner_bot_id,conversation_key) VALUES(?,?,?)', 's2', '9007199254740993123', 'group:123'), /UNIQUE/);
  assert.throws(() => store.transaction(() => {
    store.run('INSERT INTO subject(id,scope_id,qq_id) VALUES(?,?,?)', 'u1', 's1', '456');
    throw new Error('模拟中途失败');
  }), /模拟中途失败/);
  assert.equal(store.get('SELECT count(*) n FROM subject').n, 0);
  assert.throws(() => store.run('INSERT INTO subject(id,scope_id,qq_id) VALUES(?,?,?)', 'u2', 'missing', '456'), /FOREIGN KEY/);
  await assert.rejects(openMemoryStore({ file }), /占用/);
  const backup = path.join(dir, 'backup.sqlite');
  await store.backupTo(backup);
  assert.ok(fs.statSync(backup).size > 0);
  await store.close();
  store = await openMemoryStore({ file });
  assert.equal(store.get('SELECT count(*) n FROM memory_scope').n, 1);
  assert.equal(store.get('SELECT count(*) n FROM schema_migration').n, 1);
  assert.equal(store.capabilities.fts5, true);
  console.log('PASS memory store: identity, constraints, rollback, lock, backup, migration, config');
} finally {
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
