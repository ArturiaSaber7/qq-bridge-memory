// 记忆边界契约：错误可跨工作线程传递，权限由宿主构造，不能信任模型传入的 actor。
export class MemoryError extends Error {
  constructor(code, message, status = 400, details) {
    super(message); this.name = 'MemoryError'; this.code = code; this.status = status; this.details = details;
  }
}
export const KINDS = Object.freeze(['reported_fact', 'episode', 'impression', 'commitment', 'knowledge']);
export const STATUSES = Object.freeze(['active', 'inactive', 'merged', 'needs_review', 'disputed']);
/** 校验纯数据字符串；ID 保持字符串，避免 QQ int64 被 Number 舍入。 */
export function requiredText(value, name, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError('INVALID_INPUT', `${name} 不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
export function requireAdmin(actor) {
  if (actor?.kind !== 'admin') throw new MemoryError('SCOPE_DENIED', '仅管理员可执行此操作', 403);
}
export function assertScope(actor, scopeId) {
  if (!actor || !['admin', 'worker', 'agent'].includes(actor.kind) || (actor.kind !== 'admin' && actor.scopeId !== scopeId)) {
    throw new MemoryError('SCOPE_DENIED', '无权访问此会话记忆', 403);
  }
}
/** JSON 解析用于已由数据库/边界保存的数据；不把任意属性合入原型。 */
export function parseJson(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
