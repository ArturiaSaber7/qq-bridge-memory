import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
import { handleMemoryRequest } from '../src/memory/http.js';
const f = await memoryFixture();
try {
  const scope = await f.service.ensureScope(admin, { ownerBotId: '100', conversationKey: 'group:123' });
  async function request(path, method = 'GET', body = {}, headers = {}) {
    let response;
    const handled = await handleMemoryRequest({ req: { method, headers }, url: new URL(path, 'http://localhost'), actor: admin, service: f.service,
      readJson: async () => body, sendJson: (data, status = 200) => { response = { data, status }; } });
    assert.equal(handled, true);
    return response;
  }
  assert.equal((await request('/api/memory/overview', 'GET', {}, { 'x-agent-token': '' })).status, 403);
  assert.equal((await request('/api/memory/overview')).data.data.scopes.length, 1);
  const created = await request('/api/memory/items', 'POST', { scopeId: scope.id, kind: 'knowledge', title: '笔记', body: '正文', idempotencyKey: 'new' });
  assert.equal(created.status, 200);
  const id = created.data.data.memoryId;
  assert.equal((await request(`/api/memory/items/${id}`)).data.data.body, '正文');
  assert.equal((await request(`/api/memory/items?scopeId=${scope.id}&limit=10000`)).data.data.items.length, 1);
  const conflict = await request(`/api/memory/items/${id}/revise`, 'POST', { scopeId: scope.id, expectedRevision: 9, title: '更新', body: '更新', idempotencyKey: 'edit' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await request('/api/memory/not-found')).status, 404);
  const policy = await request('/api/memory/policy');
  const changed = await request('/api/memory/policy', 'POST', { expectedRevision: policy.data.data.revision, config: { enabled: true, mode: 'shadow' } });
  assert.equal(changed.data.data.config.enabled, true);
  assert.equal((await request('/api/memory/policy', 'POST', { expectedRevision: 0, config: { enabled: true } })).status, 409);
  console.log('PASS memory API: admin-only, envelopes, errors, pagination, policy conflicts');
} finally { await f.close(); }
