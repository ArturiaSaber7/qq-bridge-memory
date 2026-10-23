// 中文字符 n-gram 以安全词项写入 FTS5；查询内容永远不作为 FTS 语法执行。
export function memoryTerms(text) {
  const parts = String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const terms = new Set();
  for (const part of parts) {
    if (/^[a-z0-9]+$/.test(part)) { terms.add(`w${part}`); continue; }
    const chars = Array.from(part);
    for (let i = 0; i < chars.length; i++) {
      terms.add(`c${chars[i].codePointAt(0).toString(16)}`);
      if (i + 1 < chars.length) terms.add(`b${chars[i].codePointAt(0).toString(16)}x${chars[i + 1].codePointAt(0).toString(16)}`);
    }
  }
  return [...terms];
}
/** vectorSearch 为可选本地适配器；缺失时显式降级，不调用付费远程服务。 */
export function createMemoryIndexes({ store, vectorSearch }) {
  return {
    async applyDirty({ scopeId }) {
      store.transaction(() => {
        for (const row of store.all("SELECT * FROM memory_outbox WHERE scope_id=? AND status='queued' ORDER BY id LIMIT 500", scopeId)) {
          store.run('DELETE FROM memory_fts WHERE memory_id=?', row.target_id);
          const item = store.get('SELECT m.*,r.title,r.body FROM memory_item m JOIN memory_revision r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.id=? AND m.scope_id=?', row.target_id, scopeId);
          if (item?.status === 'active') store.run('INSERT INTO memory_fts(memory_id,scope_id,terms) VALUES(?,?,?)', item.id, scopeId, memoryTerms(`${item.title} ${item.body}`).join(' '));
          store.run("UPDATE memory_outbox SET status='done' WHERE id=?", row.id);
        }
      });
    },
    async search({ scopeId, query, limits = {} }) {
      await this.applyDirty({ scopeId });
      const terms = memoryTerms(query).slice(0, 80);
      const lexical = terms.length ? store.all('SELECT memory_id id,bm25(memory_fts) score FROM memory_fts WHERE memory_fts MATCH ? AND scope_id=? ORDER BY score LIMIT ?', terms.map(t => `"${t}"`).join(' OR '), scopeId, limits.lexical || 20) : [];
      let vector = [], vectorStatus = 'unavailable';
      if (vectorSearch) {
        try { vector = await vectorSearch({ scopeId, query, limit: limits.vector || 20 }); vectorStatus = 'available'; }
        catch { vectorStatus = 'failed'; }
      }
      return { lexical, vector, coverage: { lexical: 'chinese-ngram', vector: vectorStatus } };
    },
    async removeSources({ scopeId }) {
      // 清除服务先改变权威状态；索引只负责删除，绝不从缓存恢复正文。
      store.run('DELETE FROM memory_fts WHERE scope_id=?', scopeId);
      store.run("UPDATE memory_outbox SET status='queued' WHERE scope_id=?", scopeId);
      await this.applyDirty({ scopeId });
    }
  };
}
