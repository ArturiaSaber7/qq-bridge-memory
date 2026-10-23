import assert from 'node:assert/strict';
import { memoryFixture, admin } from './memory-test-fixture.mjs';
import { createMemoryJobs } from '../src/memory/jobs.js';
import { createMemoryBudget } from '../src/memory/budget.js';
const f=await memoryFixture({config:{enabled:true,consolidation:{maxRequestsPerAccountDay:50,maxInputTokensPerRequest:2500}}});
try{
  const scope=await f.service.ensureScope(admin,{ownerBotId:'1',conversationKey:'private:2'});
  const original='完整消息🙂'.repeat(400);
  await f.service.captureMessage(admin,{scopeId:scope.id,senderId:'2',text:original});
  let seen='';const getConfig=()=>f.service.getConfig();
  const jobs=createMemoryJobs({store:f.store,service:f.service,getConfig,budget:createMemoryBudget({store:f.store,getConfig}),model:{async generate({input}){assert.ok(Buffer.byteLength(input)<=2500);seen+=JSON.parse(input).messages[0].text;return{text:'{"candidates":[]}',usage:null};}}});
  for(let i=0;i<30;i++){await jobs.enqueueJob(admin,{scopeId:scope.id});await jobs.runNext();if(f.store.get('SELECT last_source_order n FROM memory_cursor WHERE scope_id=?',scope.id)?.n===1)break;}
  assert.equal(seen,original);assert.equal(f.store.get('SELECT source_offset n FROM memory_cursor WHERE scope_id=?',scope.id).n,0);
  console.log('memory batching: PASS (long Unicode source, bounded input, exact cursor coverage)');
}finally{await f.close();}
