// 复用桥接 HTTP 服务的 Host/Origin/令牌验证。此处仍拒绝 agent 请求，形成明确管理边界。
import { MemoryError, requireAdmin } from './contracts.js';
/** 返回是否命中记忆管理路由；所有错误转换为稳定 DTO，不回显内部路径。 */
export async function handleMemoryRequest({ req, url, actor, service, readJson, sendJson }) {
  if (!url.pathname.startsWith('/api/memory/')) return false;
  try {
    if (Object.hasOwn(req.headers, 'x-agent-token') || Object.hasOwn(req.headers, 'x-agent-call')) throw new MemoryError('SCOPE_DENIED', '该接口仅控制台可用', 403);
    requireAdmin(actor);
    const parts = url.pathname.slice('/api/memory/'.length).split('/').map(decodeURIComponent);
    const [resource, id, action] = parts;
    const filter = Object.fromEntries(url.searchParams);
    let data, status = 200;
    if (req.method === 'GET') {
      if (resource === 'items' && !id) data = await service.listItems(actor, filter);
      else if (resource === 'items' && !action) data = await service.getItem(actor, { memoryId: id, revision: filter.revision ? Number(filter.revision) : undefined });
      else if (resource === 'policy') data = await service.getPolicy(actor);
      else {
        const reads = { overview: 'overview', subjects: id ? 'subject' : 'subjects', jobs: id ? 'job' : 'jobs', issues: id ? 'issue' : 'issues', operations: id ? 'operation' : 'operations', messages: 'messages', views: 'views', graph: 'graph', 'context-status': 'context-status' };
        const selected = resource === 'items' && ['revisions', 'evidence', 'relations'].includes(action) ? action : reads[resource];
        if (!selected) throw new MemoryError('NOT_FOUND', '接口不存在', 404);
        data = await service.readResource(actor, { ...filter, resource: selected, id: id || filter.id });
      }
    } else if (req.method === 'POST') {
      const body = await readJson();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MemoryError('INVALID_INPUT', '请求体必须是对象');
      if (resource === 'items' && !id) data = await service.createItem(actor, body);
      else if (resource === 'items' && action === 'revise') data = await service.reviseItem(actor, { ...body, memoryId: id });
      else if (resource === 'items' && action === 'status') data = await service.setStatus(actor, { ...body, memoryId: id });
      else if (resource === 'policy') data = await service.updatePolicy(actor, body);
      else if (resource === 'search') data = await service.listItems(actor, body);
      else if (resource === 'views') data = await service.saveView(actor, body);
      else if (resource === 'issues' && action === 'resolve') data = await service.resolveIssue(actor, { ...body, issueId: id });
      else if (resource === 'jobs' && !id) { data = await service.enqueueJob(actor, body); status = 202; }
      else if (resource === 'jobs' && ['retry', 'cancel'].includes(action)) data = await service.changeJob(actor, { jobId: id, action });
      else if (resource === 'recall-preview') data = await service.previewRecall(actor, body);
      else if (resource === 'merge' && id === 'preview') data = await service.previewMerge(actor, body);
      else if (resource === 'merge' && id === 'commit') data = await service.commitMerge(actor, body);
      else if (resource === 'erase' && id === 'preview') data = await service.previewErase(actor, body);
      else if (resource === 'erase' && id === 'commit') { data = await service.commitErase(actor, body); status = 202; }
      else throw new MemoryError('NOT_FOUND', '接口不存在', 404);
    } else throw new MemoryError('METHOD_NOT_ALLOWED', '方法不支持', 405);
    sendJson({ ok: true, data }, status);
  } catch (error) {
    sendJson({ ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof MemoryError || error.code ? error.message : '记忆服务暂时不可用', details: error.details } }, error.status || 500);
  }
  return true;
}
