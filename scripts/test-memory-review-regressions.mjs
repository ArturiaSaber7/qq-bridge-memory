import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
import { createMemoryJobs } from '../src/memory/jobs.js';
import { createMemoryBudget } from '../src/memory/budget.js';
import { createMemoryIndexes } from '../src/memory/indexes.js';
import { createMemoryRecall } from '../src/memory/recall.js';

test('关闭/观察模式阻止模型工具，逐会话策略不会改变其他会话', async()=>{
  const f=await memoryFixture({config:{enabled:true,mode:'shadow'}});
  try{const a=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:2'}),b=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:3'});
    const actor={kind:'agent',scopeId:a.id};
    await assert.rejects(f.service.authorizeAgent(actor,{scopeId:a.id}),{code:'MEMORY_DISABLED'});
    await f.service.updatePolicy(admin,{scopeId:a.id,expectedRevision:1,config:{enabled:true,mode:'active'}});
    await f.service.authorizeAgent(actor,{scopeId:a.id});
    await assert.rejects(f.service.authorizeAgent({kind:'agent',scopeId:b.id},{scopeId:b.id}),{code:'MEMORY_DISABLED'});
    await f.service.updatePolicy(admin,{expectedRevision:0,config:{enabled:false}});
    await assert.rejects(f.service.authorizeAgent(actor,{scopeId:a.id}),{code:'MEMORY_DISABLED'});
  }finally{await f.close();}
});
test('清除苹果后香蕉仍能召回',async()=>{
  const f=await memoryFixture();try{
    const scope=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:2'});
    const create=title=>f.service.createItem(admin,{scopeId:scope.id,kind:'knowledge',title,body:title,idempotencyKey:title});
    const apple=await create('苹果'),banana=await create('香蕉');
    const recall=createMemoryRecall({store:f.store,indexes:createMemoryIndexes({store:f.store})});
    assert.equal((await recall.buildPacket({scopeId:scope.id,generation:0,query:'香蕉'})).refs[0].memoryId,banana.memoryId);
    const plan=await f.service.previewErase(admin,{scopeId:scope.id,memoryIds:[apple.memoryId]});
    const operation=await f.service.commitErase(admin,{plan,idempotencyKey:'erase',reason:'删除苹果'});
    await f.service.completeErase({kind:'worker',scopeId:scope.id},{operationId:operation.operationId,generation:1,contextRetired:true});
    assert.equal((await recall.buildPacket({scopeId:scope.id,generation:1,query:'香蕉'})).refs[0]?.memoryId,banana.memoryId);
  }finally{await f.close();}
});
test('重建续批覆盖全部原文而非重复首段',async()=>{
  const f=await memoryFixture({config:{enabled:true,consolidation:{maxInputTokensPerRequest:2500,maxRequestsPerAccountDay:50}}});try{
    const scope=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:2'}),original='长原文🙂'.repeat(500);
    await f.service.captureMessage(admin,{scopeId:scope.id,senderId:'2',text:original});
    await f.service.captureMessage(admin,{scopeId:scope.id,senderId:'2',text:'最后消息'});
    let text='';const getConfig=()=>f.service.getConfig();
    const jobs=createMemoryJobs({store:f.store,service:f.service,getConfig,budget:createMemoryBudget({store:f.store,getConfig}),model:{async generate({input}){text+=JSON.parse(input).messages.map(m=>m.text).join('');return{text:'{"candidates":[]}',usage:null};}}});
    const task=await jobs.enqueueJob(admin,{scopeId:scope.id,type:'rebuild'});
    for(let i=0;i<30;i++){await jobs.runNext();if(f.store.get('SELECT status FROM memory_job WHERE id=?',task.jobId).status==='succeeded')break;}
    assert.equal(text,original+'最后消息');
  }finally{await f.close();}
});
test('普通额度耗尽不阻塞反思额度',async()=>{
  const f=await memoryFixture({config:{enabled:true}});try{
    const scope=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:2'});
    await f.service.captureMessage(admin,{scopeId:scope.id,senderId:'2',text:'来源'});
    const getConfig=()=>f.service.getConfig(),budget=createMemoryBudget({store:f.store,getConfig});
    for(let i=0;i<4;i++)await budget.reserve({accountId:'1',purpose:'consolidation',inputTokens:100,maxOutputTokens:100});
    const jobs=createMemoryJobs({store:f.store,service:f.service,getConfig,budget,model:{async generate(){return{text:'{"candidates":[]}',usage:null};}}});
    const blocked=await jobs.enqueueJob(admin,{scopeId:scope.id}),runnable=await jobs.enqueueJob(admin,{scopeId:scope.id,type:'reflection'});
    f.store.run('UPDATE memory_job SET created_at=0 WHERE id=?',blocked.jobId);
    await jobs.runNext();
    assert.equal(f.store.get('SELECT status FROM memory_job WHERE id=?',runnable.jobId).status,'succeeded');
  }finally{await f.close();}
});
