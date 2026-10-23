// SQLite 连接归工作线程独占；QQ 收发线程只等待消息结果，不执行同步 SQL。
import { parentPort, workerData } from 'node:worker_threads';
import { openMemoryStore } from './store.js';
import { createMemoryService } from './service.js';
import { createMemoryIndexes } from './indexes.js';
import { createMemoryRecall } from './recall.js';
import { createMemoryContext } from './context.js';
import { createMemoryBudget } from './budget.js';
import { createMemoryJobs } from './jobs.js';
import { requireAdmin, MemoryError } from './contracts.js';

const store = await openMemoryStore({ file: workerData.file });
const service = createMemoryService({ store, config: workerData.config });
const getConfig = () => service.getConfig();
const indexes = createMemoryIndexes({ store });
const recall = createMemoryRecall({ store, indexes, getConfig });
const context = createMemoryContext({ store });
const pending = new Map();
let sequence = 0;
const model = { generate(input) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new MemoryError('MODEL_TIMEOUT', '整理模型调用超时', 504)); }, 120000);
    pending.set(id, { resolve, reject, timer });
    parentPort.postMessage({ type: 'model', id, input });
  });
} };
const jobs = createMemoryJobs({ store, service, budget: createMemoryBudget({ store, getConfig }), model, getConfig });
Object.assign(service, {
  enqueueJob: jobs.enqueueJob, changeJob: jobs.changeJob,
  async previewRecall(actor, input) {
    requireAdmin(actor);
    const scope = store.get('SELECT * FROM memory_scope WHERE id=?', input.scopeId);
    if (!scope) throw new MemoryError('NOT_FOUND', '范围不存在', 404);
    return recall.buildPacket({ ...input, generation: scope.generation });
  }
});
const hostMethods = { buildPacket: recall.buildPacket, bindSession: context.bindSession, confirmDelivery: context.confirmDelivery, markUnknown: context.markUnknown, tick: jobs.tick };
// 重启后不知道原生压缩留下了哪些内容，不能继续相信上次进程的可见回执。
store.run("UPDATE context_receipt SET visibility='unknown'");
const timer = setInterval(() => jobs.tick().catch(error => parentPort.postMessage({ type: 'warning', code: error.code || 'JOB_ERROR' })), 60000);
parentPort.on('message', async message => {
  if (message.type === 'model-result') {
    const task = pending.get(message.id);
    if (!task) return;
    clearTimeout(task.timer); pending.delete(message.id);
    if (message.error) task.reject(Object.assign(new Error(message.error.message), message.error));
    else task.resolve(message.result);
    return;
  }
  const { id, method, args = [] } = message;
  try {
    if (method === 'close') clearInterval(timer);
    const fn = Object.hasOwn(hostMethods, method) ? hostMethods[method] : Object.hasOwn(service, method) ? service[method] : null;
    if (!fn) throw new MemoryError('NOT_FOUND', '未知记忆方法', 404);
    const result = await fn(...args);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, error: { code: error.code || 'INTERNAL_ERROR', status: error.status || 500, message: error instanceof MemoryError ? error.message : '记忆操作失败', details: error.details } });
  }
});
parentPort.postMessage({ type: 'ready' });
