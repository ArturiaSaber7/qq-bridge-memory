// SQLite 仅由宿主 memory worker 使用；同步事务禁止跨 await，避免并发任务混写事务。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MemoryError } from './contracts.js';

/**
 * 打开持久库并执行追加式迁移。file 必须来自宿主配置，不接受模型输入。
 * @returns {Promise<object>} 内部 SQL 接口、同步 transaction、backupTo 和可重复 close。
 */
export async function openMemoryStore({ file, migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url)), clock = Date.now }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let alive = true;
    try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (pid > 0) process.kill(pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
    if (alive) throw new MemoryError('STORE_LOCKED', '记忆数据库已被其他进程占用', 503);
    fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
  }
  fs.writeFileSync(fd, String(process.pid));
  let db;
  const unlock = () => { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; fs.unlinkSync(lock); } };
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON;');
    const current = db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migration'").get()
      ? db.prepare('SELECT coalesce(max(version),0) version FROM schema_migration').get().version : 0;
    for (const name of fs.readdirSync(migrationsDir).filter(x => /^\d+.*\.sql$/.test(x)).sort()) {
      const version = Number(name.match(/^\d+/)[0]);
      if (version <= current) continue;
      // VACUUM INTO 创建一致备份，避免复制主文件时遗漏 WAL 内容。
      if (current > 0) db.prepare('VACUUM INTO ?').run(`${file}.before-${version}-${clock()}.bak`);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
        db.prepare('INSERT INTO schema_migration VALUES(?,?)').run(version, clock()); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    let closed = false;
    let inTransaction = false;
    return {
      capabilities: { sqlite: true, fts5: true },
      run: (sql, ...params) => db.prepare(sql).run(...params),
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
      transaction(work) {
        if (inTransaction) return work();
        db.exec('BEGIN IMMEDIATE'); inTransaction = true;
        try {
          const result = work();
          if (result?.then) throw new MemoryError('ASYNC_TRANSACTION', '事务回调不能返回 Promise');
          db.exec('COMMIT'); return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        finally { inTransaction = false; }
      },
      async backupTo(target) { db.prepare('VACUUM INTO ?').run(target); },
      checkpoint() { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); },
      async close() { if (closed) return; closed = true; try { db.close(); } finally { unlock(); } }
    };
  } catch (error) { try { db?.close(); } finally { unlock(); } throw error; }
}
