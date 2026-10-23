// 由控制台宿主嵌入同一脚本，复用现有认证、主题和导航；记忆正文永不作为 HTML 执行。
const memoryUI = { scopeId: '', item: null, items: [], view: 'library', busy: false, cursor: null };
const memoryKindLabels = { reported_fact: '事实', episode: '经历', impression: '印象', commitment: '约定', knowledge: '知识' };
const memoryStatusLabels = { active: '生效', inactive: '停用', merged: '已合并', needs_review: '待核实', disputed: '有争议' };
const memoryNav = document.createElement('button');
memoryNav.className = 'nav-item'; memoryNav.dataset.view = 'memory';
memoryNav.textContent = '◇ 记忆管理';
document.getElementById('mainNav').append(memoryNav);
const memoryRoot = document.createElement('section');
memoryRoot.id = 'memoryConsole'; memoryRoot.dataset.page = 'memory'; memoryRoot.className = 'card span-all'; memoryRoot.hidden = true;
memoryRoot.innerHTML = `<style>
#memoryConsole .memory-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px}
#memoryConsole .memory-workspace{display:grid;grid-template-columns:minmax(220px,30%) minmax(0,1fr);gap:24px}
#memoryConsole .memory-list{max-height:65vh;overflow:auto;border-right:1px solid var(--border);padding-right:16px}
#memoryConsole .memory-entry{display:block;width:100%;text-align:left;margin:0 0 8px;padding:12px;white-space:normal}
#memoryConsole .memory-entry small{display:block;opacity:.65;margin-top:6px}
#memoryConsole textarea{width:100%;min-height:190px;resize:vertical}
#memoryConsole pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:rgba(128,128,128,.08)}
#memoryConsole input,#memoryConsole select{max-width:100%} #memoryConsole h3{margin-top:20px}
#memoryConsole .memory-error{color:#d45948;white-space:pre-wrap} #memoryConsole .memory-meta{opacity:.7;font-size:12px}
#memoryConsole .memory-preview{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid var(--border)}
#memoryConsole svg{width:100%;height:280px} #memoryConsole svg text{fill:currentColor;font-size:12px}
@media(max-width:760px){#memoryConsole .memory-workspace{grid-template-columns:1fr}#memoryConsole .memory-list{max-height:240px;border-right:0;border-bottom:1px solid var(--border)}}
</style><h2>长期记忆</h2><div class="memory-toolbar"><label>会话 <select id="memoryScope" aria-label="记忆会话"></select></label><label>视图 <select id="memoryView"><option value="library">记忆库</option><option value="subjects">人物</option><option value="graph">关系图</option><option value="issues">待处理</option><option value="jobs">整理任务</option><option value="policy">策略</option><option value="recall">召回预览</option></select></label><button id="memoryRefresh">刷新</button><button id="memoryNew">新建记忆</button></div>
<div id="memorySummary" class="memory-meta"></div><p id="memoryError" class="memory-error" role="alert"></p>
<div class="memory-toolbar"><label>搜索 <input id="memoryQuery" type="search" placeholder="标题或正文"></label><label>类型 <select id="memoryKind"><option value="">全部</option>${Object.entries(memoryKindLabels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>状态 <select id="memoryStatus"><option value="">全部</option>${Object.entries(memoryStatusLabels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><button id="memorySearch">查询</button><button id="memorySaveView">保存视图</button></div>
<div class="memory-workspace"><div id="memoryList" class="memory-list"></div><div id="memoryDetail"><p>选择一条记忆查看正文、来源和历史。</p></div></div>`;
document.querySelector('main .grid').append(memoryRoot);
const memEl = id => document.getElementById(id);
for (const [value,label] of [['messages','来源记录'],['topics','主题'],['views','已保存视图'],['context-status','上下文状态']]) {
  const option=document.createElement('option');option.value=value;option.textContent=label;memEl('memoryView').append(option);
}
async function memoryRequest(path, method = 'GET', body) {
  const result = await api('/api/memory/' + path, method, body);
  if (!result.ok) throw new Error(`${result.error?.code || '请求失败'}：${result.error?.message || result.error || '服务不可用'}`);
  return result.data;
}
async function memoryAction(action) {
  if (memoryUI.busy) return;
  memoryUI.busy = true; memEl('memoryError').textContent = '';
  try { await action(); } catch (error) { memEl('memoryError').textContent = error.message; }
  finally { memoryUI.busy = false; }
}
function memoryButton(label, action) {
  const button = document.createElement('button'); button.textContent = label;
  button.addEventListener('click', () => memoryAction(action)); return button;
}
function memoryText(tag, text, parent) { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; }
async function refreshMemoryConsole() {
  await memoryAction(async () => {
    const route = new URLSearchParams(location.hash.split('?')[1] || '');
    if (route.has('scope')) memoryUI.scopeId = route.get('scope');
    if ([...memEl('memoryView').options].some(option=>option.value===route.get('view'))) memEl('memoryView').value=route.get('view');
    const overview = await memoryRequest('overview');
    memEl('memoryScope').replaceChildren(...overview.scopes.map(s => { const o=document.createElement('option');o.value=s.id;o.textContent=`${s.conversation_key} · QQ ${s.owner_bot_id}${s.barrier?' · 清除待完成':''}`;return o; }));
    memoryUI.scopeId = overview.scopes.some(s=>s.id===memoryUI.scopeId) ? memoryUI.scopeId : overview.scopes[0]?.id || '';
    memEl('memoryScope').value = memoryUI.scopeId;
    memEl('memorySummary').textContent = `${overview.counts.items} 条记忆 · ${overview.counts.issues} 项待处理 · ${overview.counts.jobs} 个任务 · ${overview.config.enabled ? overview.config.mode : '长期记忆未启用'} · 中文全文检索；向量能力：${overview.capabilities.vector}`;
    await memoryLoadView();
    if (route.get('item')) {
      const item=await memoryRequest('items/'+encodeURIComponent(route.get('item')));
      if(item.scopeId===memoryUI.scopeId)await memoryOpenItem(item.id);
    }
  });
}
async function memoryLoadView() {
  const view = memEl('memoryView').value, list = memEl('memoryList'), pane = memEl('memoryDetail');
  memoryUI.view = view; list.replaceChildren(); pane.replaceChildren();
  if (view === 'policy') {
    const policy = await memoryRequest('policy');
    memoryText('h3','记忆策略',pane);
    memoryText('p','先使用 shadow 观察整理结果，再切换 active 注入聊天。修改额度不会增加模型能力。',pane);
    const controls=[];
    for(const [path,label,type,options] of [
      ['enabled','长期记忆','select',[['false','关闭'],['true','启用']]],
      ['mode','使用模式','select',[['shadow','仅整理观察'],['active','整理并注入聊天']]],
      ['recall.normalMaxItems','日常最多召回条数','number'],['recall.normalMaxTokens','日常召回预算','number'],
      ['recall.deepMaxTokens','深入查询预算','number'],['consolidation.maxRequestsPerAccountDay','每日普通整理次数','number'],
      ['reflection.maxRequestsPerAccountDay','每日反思次数','number'],['consolidation.triggerMessages','批量整理消息数','number']
    ]) {
      const keys=path.split('.'),value=keys.reduce((v,k)=>v[k],policy.config),labelEl=document.createElement('label');labelEl.textContent=label+' ';
      const control=document.createElement(type==='select'?'select':'input');if(type!=='select'){control.type='number';control.min='1';}
      for(const [v,l]of options||[]){const option=document.createElement('option');option.value=v;option.textContent=l;control.append(option);}
      control.value=String(value);labelEl.append(control);const row=document.createElement('div');row.className='memory-toolbar';row.append(labelEl);pane.append(row);controls.push({keys,control,type});
    }
    pane.append(memoryButton('保存策略', async()=>{const config=structuredClone(policy.config);for(const {keys,control,type}of controls){const target=keys.length===1?config:config[keys[0]];target[keys.at(-1)]=keys[0]==='enabled'?control.value==='true':type==='number'?Number(control.value):control.value;}await memoryRequest('policy','POST',{expectedRevision:policy.revision,config});await memoryLoadView();})); return;
  }
  if (!memoryUI.scopeId) { memoryText('p','暂无会话。启用策略后，二代仿真收到消息时会建立记忆范围。',pane);return; }
  const scope = 'scopeId='+encodeURIComponent(memoryUI.scopeId);
  if(view==='context-status'){memoryText('h3','上下文能力',pane);memoryText('pre',JSON.stringify(await memoryRequest('context-status?'+scope),null,2),pane);return;}
  if(view==='topics'){
    const data=await memoryRequest('items?'+scope+'&limit=100'),topics=new Map();
    for(const item of data.items)for(const topic of item.topics){if(!topics.has(topic))topics.set(topic,[]);topics.get(topic).push(item);}
    for(const [topic,items]of topics)list.append(memoryButton(`${topic} (${items.length})`,async()=>{pane.replaceChildren();memoryText('h3',topic,pane);for(const item of items)pane.append(memoryButton(item.title,()=>memoryOpenItem(item.id)));}));
    memoryText('p',data.nextCursor?'当前展示前100条记忆的主题，可通过记忆库搜索查看更多。':'主题来自记忆的主题字段。',pane);return;
  }
  if (view === 'library') {
    const query = new URLSearchParams({scopeId:memoryUI.scopeId,query:memEl('memoryQuery').value,kind:memEl('memoryKind').value,status:memEl('memoryStatus').value});
    const renderItems = data => {
      memoryUI.items.push(...data.items);
      for (const item of data.items) {
        const button=memoryButton(item.title,()=>memoryOpenItem(item.id));button.className='memory-entry';
        memoryText('small',`${memoryKindLabels[item.kind]} · ${memoryStatusLabels[item.status]} · v${item.revision}`,button);list.append(button);
      }
      if(data.nextCursor) { const more=memoryButton('加载更多',async()=>{more.remove();renderItems(await memoryRequest('items?'+query+'&cursor='+encodeURIComponent(data.nextCursor)));});list.append(more); }
    };
    memoryUI.items=[];renderItems(await memoryRequest('items?'+query));
    if(!memoryUI.items.length) memoryText('p','没有符合筛选条件的记忆。',list);
    memoryText('p','选择记忆查看证据与版本，或新建一条管理员记录。',pane);return;
  }
  if(view==='recall') {
    memoryText('h3','召回预览',pane);
    const query=document.createElement('input');query.placeholder='输入一句聊天内容';query.setAttribute('aria-label','召回查询');pane.append(query);
    const mode=document.createElement('select');mode.innerHTML='<option value="normal">日常预算</option><option value="deep">深入查询</option>';pane.append(mode);
    const result=document.createElement('pre');pane.append(memoryButton('预览',async()=>{result.textContent=JSON.stringify(await memoryRequest('recall-preview','POST',{scopeId:memoryUI.scopeId,query:query.value,mode:mode.value,visibilityMode:'fresh'}),null,2);}),result);return;
  }
  if(view==='graph') {
    const graph=await memoryRequest('graph?'+scope+(memoryUI.item?'&id='+encodeURIComponent(memoryUI.item.id):''));
    memoryText('h3','一跳关系',pane);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 280');svg.setAttribute('aria-label','记忆关系图');
    const positions=new Map(graph.nodes.map((n,i)=>[n.id,{x:300+210*Math.cos(i*2*Math.PI/Math.max(1,graph.nodes.length)),y:140+100*Math.sin(i*2*Math.PI/Math.max(1,graph.nodes.length))}]));
    for(const edge of graph.edges){const a=positions.get(edge.from_id),b=positions.get(edge.to_id);if(!a||!b)continue;const line=document.createElementNS(svg.namespaceURI,'line');for(const [k,v]of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#84978c'}))line.setAttribute(k,v);svg.append(line);}
    for(const node of graph.nodes){const p=positions.get(node.id),label=document.createElementNS(svg.namespaceURI,'text');label.setAttribute('x',p.x);label.setAttribute('y',p.y);label.setAttribute('text-anchor','middle');label.textContent=node.title.slice(0,16);svg.append(label);list.append(memoryButton(node.title,()=>memoryOpenItem(node.id)));}pane.append(svg);return;
  }
  const rows=await memoryRequest(view+'?'+scope);
  if(view==='jobs') for(const type of ['consolidation','reflection','rebuild']) list.append(memoryButton({consolidation:'整理新来源',reflection:'反思',rebuild:'重建'}[type],async()=>{await memoryRequest('jobs','POST',{scopeId:memoryUI.scopeId,type});await memoryLoadView();}));
  for(const row of rows) {
    const button=memoryButton(row.name||`${row.type} · ${row.status}`,async()=>{
      pane.replaceChildren();
      if(view==='views'){const saved=row.data||{};memEl('memoryQuery').value=saved.query||'';memEl('memoryKind').value=saved.kind||'';memEl('memoryStatus').value=saved.status||'';memEl('memoryView').value='library';await memoryLoadView();return;}
      if(view==='subjects'){const person=await memoryRequest('subjects/'+row.id+'?'+scope);memoryText('h3',person.name+' · '+person.qq_id,pane);for(const item of person.memories.items)pane.append(memoryButton(item.title,()=>memoryOpenItem(item.id)));return;}
      memoryText('pre',JSON.stringify(row,null,2),pane);
      if(view==='jobs')for(const action of ['retry','cancel'])pane.append(memoryButton(action==='retry'?'重试':'取消',async()=>{await memoryRequest(`jobs/${row.id}/${action}`,'POST',{});await memoryLoadView();}));
      if(view==='issues'&&row.status==='open') {
        const reason=document.createElement('input');reason.placeholder='处理理由';pane.append(reason);
        const qqId=document.createElement('input');qqId.placeholder='绑定的 QQ 号';pane.append(qqId);
        const sourceId=document.createElement('input');sourceId.placeholder='要解除的来源 ID';pane.append(sourceId);
        for(const [action,label]of [['dismiss','忽略'],['accept','确认'],['keep_disputed','保留争议'],['bind_identity','绑定人物'],['detach_evidence','解除证据']])pane.append(memoryButton(label,async()=>{
          const expectedRevisions={};for(const id of row.payload?.memoryIds||[])expectedRevisions[id]=(await memoryRequest('items/'+id)).revision;
          await memoryRequest(`issues/${row.id}/resolve`,'POST',{action,reason:reason.value,qqId:qqId.value,sourceId:sourceId.value,issueRevision:row.revision,expectedRevisions,idempotencyKey:crypto.randomUUID()});await memoryLoadView();
        }));
      }
    });button.className='memory-entry';list.append(button);
  }
  if(!rows.length)memoryText('p','暂无记录。',pane);
}
async function memoryOpenItem(id) {
  const item=await memoryRequest('items/'+encodeURIComponent(id));memoryUI.item=item;
  history.replaceState({},'', '#memory?'+new URLSearchParams({scope:item.scopeId,view:memoryUI.view,item:id}));
  const pane=memEl('memoryDetail');pane.replaceChildren();
  memoryText('h3',item.title,pane);memoryText('p',`${memoryKindLabels[item.kind]} · ${memoryStatusLabels[item.status]} · v${item.revision} · ${item.id}`,pane).className='memory-meta';
  const title=document.createElement('input');title.value=item.title;title.setAttribute('aria-label','记忆标题');pane.append(title);
  const editor=document.createElement('textarea');editor.value=item.body;editor.setAttribute('aria-label','记忆正文 Markdown');pane.append(editor);
  // 保守预览仅解析标题与段落，原始 HTML 和外链不会执行；[[id]] 由受控按钮导航。
  const preview=document.createElement('div');preview.className='memory-preview';
  const renderPreview=()=>{preview.replaceChildren();for(const line of editor.value.split('\n')){const match=line.match(/^(#{1,3})\s+(.*)$/);memoryText(match?'h'+(match[1].length+2):'div',match?match[2]:line,preview);}};editor.addEventListener('input',renderPreview);renderPreview();pane.append(preview);
  const reason=document.createElement('input');reason.placeholder='修改理由';reason.setAttribute('aria-label','修改理由');pane.append(reason);
  const topics=document.createElement('input');topics.value=item.topics.join('，');topics.placeholder='主题，用逗号分隔';topics.setAttribute('aria-label','记忆主题');pane.append(topics);
  pane.append(memoryButton('保存新版本',async()=>{await memoryRequest(`items/${item.id}/revise`,'POST',{scopeId:item.scopeId,expectedRevision:item.revision,title:title.value,body:editor.value,reason:reason.value,subjectIds:item.subjectIds,topics:topics.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),sourceIds:item.evidence.map(e=>e.id),idempotencyKey:crypto.randomUUID()});await memoryOpenItem(item.id);}));
  pane.append(memoryButton(item.status==='inactive'?'启用':'停用',async()=>{await memoryRequest(`items/${item.id}/status`,'POST',{expectedRevision:item.revision,status:item.status==='inactive'?'active':'inactive',reason:'控制台切换状态',idempotencyKey:crypto.randomUUID()});await memoryOpenItem(item.id);}));
  pane.append(memoryButton('来源证据',async()=>{const rows=await memoryRequest(`items/${item.id}/evidence`);details.replaceChildren();for(const source of rows)memoryText('pre',JSON.stringify(source,null,2),details);}));
  pane.append(memoryButton('历史与恢复',async()=>{
    const revisions=await memoryRequest(`items/${item.id}/revisions`);details.replaceChildren();
    for(const rev of revisions){memoryText('h4',`v${rev.revision} · ${new Date(rev.recordedAt).toLocaleString()}`,details);memoryText('pre',rev.body,details);if(rev.revision!==item.revision)details.append(memoryButton('恢复为新版本',async()=>{await memoryRequest(`items/${item.id}/revise`,'POST',{...rev,memoryId:undefined,scopeId:item.scopeId,expectedRevision:item.revision,sourceIds:rev.evidence.map(e=>e.id),reason:`恢复 v${rev.revision}`,idempotencyKey:crypto.randomUUID()});await memoryOpenItem(item.id);}));}
  }));
  pane.append(memoryButton('关联与反向链接',async()=>{details.replaceChildren();const rows=await memoryRequest(`items/${item.id}/relations`);for(const row of rows){const target=row.from_id===item.id?row.to_id:row.from_id;details.append(memoryButton(`${row.from_id===item.id?'链接':'反向链接'} · ${target}`,()=>memoryOpenItem(target)));}if(!rows.length)memoryText('p','暂无关联；正文可使用 [[记忆ID]] 建立链接。',details);}));
  pane.append(memoryButton('合并',async()=>{
    details.replaceChildren();const select=document.createElement('select');for(const other of memoryUI.items.filter(x=>x.id!==item.id&&x.status!=='merged')){const o=document.createElement('option');o.value=other.id;o.textContent=other.title;select.append(o);}details.append(select);
    details.append(memoryButton('预览合并',async()=>{const plan=await memoryRequest('merge/preview','POST',{scopeId:item.scopeId,memoryIds:[item.id,select.value],targetId:item.id});memoryText('pre',JSON.stringify(plan,null,2),details);details.append(memoryButton('确认合并并保存当前正文',async()=>{await memoryRequest('merge/commit','POST',{plan,title:title.value,body:editor.value,reason:reason.value||'控制台合并',idempotencyKey:crypto.randomUUID()});await memoryOpenItem(item.id);}));}));
  }));
  pane.append(memoryButton('清除预览',async()=>{const plan=await memoryRequest('erase/preview','POST',{scopeId:item.scopeId,memoryIds:[item.id]});details.replaceChildren();memoryText('p',`将永久清除 ${plan.memoryIds.length} 条记忆及 ${plan.sourceIds.length} 个来源，并重置此会话的上下文与旧工作记忆。远程历史是否清除无法确认。`,details);memoryText('pre',JSON.stringify(plan,null,2),details);details.append(memoryButton('确认永久清除',async()=>{await memoryRequest('erase/commit','POST',{plan,reason:reason.value||'管理员清除',idempotencyKey:crypto.randomUUID()});memoryUI.item=null;await memoryLoadView();}));}));
  const details=document.createElement('div');pane.append(details);
}
memEl('memoryRefresh').onclick=refreshMemoryConsole;
for(const id of ['memoryView','memoryScope'])memEl(id).onchange=()=>memoryAction(async()=>{memoryUI.scopeId=memEl('memoryScope').value;memoryUI.item=null;history.replaceState({},'','#memory?'+new URLSearchParams({scope:memoryUI.scopeId,view:memEl('memoryView').value}));await memoryLoadView();});
memEl('memorySearch').onclick=()=>memoryAction(memoryLoadView);
memEl('memorySaveView').onclick=()=>memoryAction(async()=>{await memoryRequest('views','POST',{scopeId:memoryUI.scopeId,name:memEl('memoryQuery').value||'记忆筛选',data:{query:memEl('memoryQuery').value,kind:memEl('memoryKind').value,status:memEl('memoryStatus').value}});showConsoleToast('视图已保存');});
memEl('memoryNew').onclick=()=>memoryAction(async()=>{
  if(!memoryUI.scopeId)throw new Error('请先选择已建立的会话');
  const pane=memEl('memoryDetail');pane.replaceChildren();memoryText('h3','新建管理员记忆',pane);
  const title=document.createElement('input');title.placeholder='标题';title.setAttribute('aria-label','新记忆标题');
  const body=document.createElement('textarea');body.placeholder='Markdown 正文';body.setAttribute('aria-label','新记忆正文');
  const kind=document.createElement('select');for(const [key,label]of Object.entries(memoryKindLabels)){const o=document.createElement('option');o.value=key;o.textContent=label;kind.append(o);}kind.value='knowledge';
  pane.append(title,kind,body,memoryButton('创建',async()=>{const result=await memoryRequest('items','POST',{scopeId:memoryUI.scopeId,title:title.value,body:body.value,kind:kind.value,reason:'管理员录入',idempotencyKey:crypto.randomUUID()});await memoryOpenItem(result.memoryId);}));
});
