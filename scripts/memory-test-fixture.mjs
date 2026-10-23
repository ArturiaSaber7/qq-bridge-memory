// 各记忆测试共用真实临时数据库；不读取生产配置、不连接 QQ/DSH。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryStore } from '../src/memory/store.js';
import { createMemoryService } from '../src/memory/service.js';
export const admin = Object.freeze({ kind: 'admin' });
export async function memoryFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
  const store = await openMemoryStore({ file: path.join(dir, 'memory.sqlite') });
  const service = createMemoryService({ store, ...options });
  return { dir, store, service, async close() { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
