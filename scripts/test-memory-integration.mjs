import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const bridge = await bridgeHarness({ config: { memory: { enabled: true, mode: 'active' } } });
const admin={kind:'admin'},key='private:123';
try {
  await bridge.captureLongMemory(key,{self_id:'999',user_id:'123',message_id:'10',sender:{nickname:'小明'}},'我喜欢咖啡');
  const runtime=await bridge.memoryRuntime();
  const scope=bridge.memoryScopes.get(key);
  const messages=await runtime.readResource(admin,{resource:'messages',scopeId:scope.id});
  assert.equal(messages[0].text,'我喜欢咖啡');
  const item=await runtime.createItem(admin,{scopeId:scope.id,kind:'reported_fact',title:'咖啡偏好',body:'小明说喜欢咖啡',sourceIds:[messages[0].source_id],idempotencyKey:'fact'});
  await bridge.deliverPrompt(key,'咖啡');
  assert.ok(JSON.stringify(bridge.calls.prompts).includes('小明说喜欢咖啡'));
  const oldGuard=bridge.captureSendGuard(key);
  const plan=await runtime.previewErase(admin,{scopeId:scope.id,memoryIds:[item.memoryId]});
  const operation=await runtime.commitErase(admin,{plan,reason:'测试清除',idempotencyKey:'erase'});
  await bridge.finishMemoryErase(runtime,operation);
  assert.throws(oldGuard,/发送已取消/);
  assert.equal(bridge.state.sessions[key],undefined);
  assert.equal(bridge.memoryScopes.get(key).generation,1);
  await bridge.captureLongMemory(key,{self_id:'999',user_id:'123',message_id:'10'},'我喜欢咖啡');
  assert.equal((await runtime.readResource(admin,{resource:'messages',scopeId:scope.id})).length,0);
  console.log('memory bridge integration: PASS (raw capture, recall injection, erasure, queued-send rejection)');
} finally { await bridge.close(); }
