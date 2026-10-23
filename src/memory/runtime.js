import { Worker } from 'node:worker_threads';
import { MemoryError } from './contracts.js';

/** 宿主仅暴露显式 RPC；调用方负责传入已认证 actor，不从请求正文构造权限。 */
export async function createMemoryRuntime({ file, config = {}, model, onWarning = () => {} }) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { file, config } });
  const waiting = new Map();
  let sequence = 0, closed = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  function fail(error) {
    readyReject(error);
    for (const task of waiting.values()) task.reject(error);
    waiting.clear(); closed = true;
  }
  worker.on('error', fail);
  worker.on('exit', code => { if (!closed) fail(new MemoryError('WORKER_STOPPED', `记忆工作线程已退出 (${code})`, 503)); });
  worker.on('message', async message => {
    if (message.type === 'ready') { readyResolve(); return; }
    if (message.type === 'warning') { onWarning(message.code); return; }
    if (message.type === 'model') {
      try {
        if (!model?.generate) throw new MemoryError('CAPABILITY_UNAVAILABLE', '尚未连接受输出预算约束的整理模型', 503);
        worker.postMessage({ type: 'model-result', id: message.id, result: await model.generate(message.input) });
      } catch (error) {
        worker.postMessage({ type: 'model-result', id: message.id, error: { code: error.code || 'MODEL_ERROR', message: error.message, notSent: error.code === 'CAPABILITY_UNAVAILABLE' } });
      }
      return;
    }
    const task = waiting.get(message.id);
    if (!task) return;
    waiting.delete(message.id);
    if (message.error) task.reject(Object.assign(new MemoryError(message.error.code, message.error.message, message.error.status), { details: message.error.details }));
    else task.resolve(message.result);
  });
  await ready;
  const call = (method, ...args) => {
    if (closed) return Promise.reject(new MemoryError('WORKER_STOPPED', '记忆服务已关闭', 503));
    if (waiting.size >= 256) return Promise.reject(new MemoryError('MEMORY_BUSY', '记忆请求队列已满，请稍后重试', 503));
    const id = ++sequence;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
  };
  const methods = ['ensureScope', 'captureMessage', 'createItem', 'proposeItem', 'reviseItem', 'getItem', 'listItems', 'setStatus', 'importLegacy', 'resolveIssue', 'getPolicy', 'updatePolicy', 'getEvidence', 'readResource', 'saveView', 'previewMerge', 'commitMerge', 'previewErase', 'commitErase', 'completeErase', 'enqueueJob', 'changeJob', 'previewRecall', 'buildPacket', 'bindSession', 'confirmDelivery', 'markUnknown', 'getConfig', 'tick'];
  return { ...Object.fromEntries(methods.map(method => [method, (...args) => call(method, ...args)])),
    async close() { if (closed) return; await call('close'); closed = true; await worker.terminate(); } };
}
