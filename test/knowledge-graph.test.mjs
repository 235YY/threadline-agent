import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {canonical} from '../src/contracts.mjs';
import {recordNode,processNode,nodeKey,traceQuery,traceTransition,walkKnowledgeGraph} from '../src/knowledge-graph.mjs';
import {assembleGraphPackages} from '../src/graph-packages.mjs';
import {verifiedModelInput} from '../src/cognition.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,disk,code} from './helpers.mjs';
import {graphFixture,seed,prepare,commit,next,trace,pin,currentFrame,lookup,observation,policy,proposal} from '../experiments/unified-graph/fixture.mjs';

const setup=t=>graphFixture(memory(t).store);
const query=(s,q,extra={})=>s.store.graphTrace({subjectId:'fixture-person',query:q.trace,...extra});
const keys=result=>result.nodes.map(n=>n.ref.id);
const n=(id,revision=1)=>recordNode(pin(id,revision));
const continuation=(s,r,extra={})=>prepare(s,{lookupResults:[pin(r.id,r.revision)],...extra});
const link=(id,from,to,relation='similar',extra={})=>({op:'write_link',id,expectedRevision:0,from:pin(from),to:pin(to),relation,direction:'both',strength:1,status:'active',basis:[],...extra});

test('统一协议显式开启，原协议不悄悄增加权限',t=>{
  const s=setup(t),p=prepare(s);assert.equal(p.stage,'decisionGraph');assert.ok(p.payload.memoryAccess.routes.includes('trace'));
  assert.deepEqual(verifiedModelInput(p).messages,p.messages);assert.equal(prepare(s,{unified:false}).stage,'decisionMind');
  assert.throws(()=>prepare(s,{mind:false}),code('UNIFIED_PROTOCOL_REQUIRED'));
  assert.throws(()=>prepare(s,{localLookupPolicy:null}),code('UNIFIED_PROTOCOL_REQUIRED'));
  assert.throws(()=>commit(s,{kind:'lookup',payload:trace('grounds',[n('source')])},{unified:false}),code('UNIFIED_PROTOCOL_REQUIRED'));
});

test('统一追溯从准备穿过认识、条件、关切到真实存储的来源',t=>{
  const s=seed(setup(t)),r=query(s,trace('grounds',[n('readiness')]));
  for(const id of ['readiness','belief','means','care','forecast','note','source'])assert.ok(keys(r).includes(id));
  assert.equal(r.nodes.length,7);assert.ok(r.paths.some(p=>p.family==='mind'));assert.ok(r.paths.some(p=>p.family==='basis'));
  assert.equal(r.interpretation,'recorded-relations-and-candidates-not-new-facts-or-proof-of-completeness');
});

test('反向索引可以从事件找引用它的认识和准备，不冒充实际心理因果',t=>{
  const s=seed(setup(t)),r=query(s,trace('impact',[n('source')]));
  assert.ok(keys(r).includes('belief'));assert.ok(keys(r).includes('readiness'));assert.ok(r.paths.every(e=>e.direction==='in'));
});

test('追原因不允许沿相似边乱跳，联想路线才允许',t=>{
  const s=setup(t);s.store.execute({requestId:'similar',commands:[observation('unrelated','别的话题'),link('sim','note','unrelated')]});
  const a=query(s,trace('grounds',[n('note')])),b=query(s,trace('associations',[n('note')]));
  assert.ok(!keys(a).includes('unrelated'));assert.ok(a.excluded.examples.some(e=>e.reason==='route-excluded'));
  assert.ok(keys(b).includes('unrelated'));
});

test('单向关联的反向入口不会被无条件反转',t=>{
  const s=setup(t);s.store.execute({requestId:'direct',commands:[link('sim','note','source','related',{direction:'forward'})]});
  assert.equal(query(s,trace('associations',[n('source')])).stop,'no-path');
  assert.ok(keys(query(s,trace('associations',[n('note')]))).includes('source'));
});

test('废弃关联只报告不可用，不重新激活',t=>{
  const s=setup(t);s.store.execute({requestId:'retired',commands:[link('sim','note','source','similar',{status:'retired'})]});
  const r=query(s,trace('associations',[n('note')]));assert.equal(r.nodes.length,1);assert.ok(r.excluded.examples.some(e=>e.reason==='retired-or-stale'));
});

test('旧认识的引用固定在旧版本，正文不偷偷换新',t=>{
  const s=seed(setup(t));commit(s,{changes:[{id:'belief',expectedRevision:1,nature:'reappraisal',body:'现在找到了一个待验证的办法。'}]},{stateRefs:[pin('belief')]});
  const r=query(s,trace('grounds',[n('readiness')])),b=r.nodes.find(x=>x.ref.id==='belief');
  assert.equal(b.ref.revision,1);assert.equal(b.historical,true);assert.equal(b.latestOwner.revision,2);
  assert.match(s.store.readGraphNode({subjectId:'fixture-person',ref:b.ref}).record.body,/还不知道/);
});

test('反向默认只看当前记录，显式选历史才拉取旧版本',t=>{
  const s=seed(setup(t));commit(s,{changes:[{id:'belief',expectedRevision:1,nature:'reappraisal',body:'新理解',basis:{observations:[],memories:[],priorStates:[]}}]},{stateRefs:[pin('belief')]});
  const a=query(s,trace('impact',[n('source')])),b=query(s,trace('impact',[n('source')],{includeHistorical:true}));
  assert.ok(!a.nodes.some(x=>x.ref.id==='belief'&&x.ref.revision===1));assert.ok(b.nodes.some(x=>x.ref.id==='belief'&&x.ref.revision===1));
});

test('过程引用包含框架版本，不和同名记录混淆',t=>{
  const s=seed(setup(t)),f=currentFrame(s),p=processNode(f,pin('home'));
  s.store.execute({requestId:'same-name',commands:[observation('home','同名事件') ]});
  assert.notEqual(nodeKey(p),nodeKey(n('home')));assert.equal(s.store.readGraphNode({subjectId:'fixture-person',ref:p}).descriptor.type,'process');
  assert.equal(s.store.readGraphNode({subjectId:'fixture-person',ref:n('home')}).descriptor.type,'event');
});

test('进度查询保留父子关系和actual/possible，设想不会变成经历',t=>{
  const s=seed(setup(t)),f=currentFrame(s),r=query(s,trace('progress',[processNode(f,pin('home'))]));
  assert.ok(keys(r).includes('materials'));const possible=r.nodes.find(x=>x.ref.id==='possible-home');assert.equal(possible.world,'possible');
  const p=s.store.readGraphNode({subjectId:'fixture-person',ref:possible.ref});assert.equal(p.record.status,'proposed');
});

test('没有对象与没有许可路径分开报告，均不推断从未经历',t=>{
  const s=setup(t),a=query(s,trace('grounds',[n('missing')])),b=query(s,trace('grounds',[n('source')]));
  assert.equal(a.stop,'not-found');assert.equal(a.missing.length,1);assert.equal(b.stop,'no-path');assert.equal(b.nodes.length,1);
});

test('深度和节点上限显式截断，不伪装查全',t=>{
  const s=seed(setup(t)),a=query(s,trace('grounds',[n('readiness')],{maxDepth:0})),b=query(s,trace('grounds',[n('readiness')],{maxNodes:2}));
  assert.ok(a.limits.includes('depth-limit'));assert.equal(a.stop,'truncated');assert.equal(a.nodes.length,1);
  assert.ok(b.limits.includes('node-limit'));assert.equal(b.nodes.length,2);
});

test('宿主命中上限不可被查询自行扩大',t=>{
  const s=seed(setup(t)),r=query(s,trace('grounds',[n('readiness')]),{maxNodes:1});assert.equal(r.nodes.length,1);assert.ok(r.limits.includes('node-limit'));
});

test('多入口多路径去重，来源正文不会因重复命中变成多条证据',t=>{
  const s=seed(setup(t)),r=lookup(s,trace('grounds',[n('readiness'),n('belief'),n('note')])),p=continuation(s,r);
  assert.equal(r.trace.nodes.filter(x=>x.ref.id==='source').length,1);assert.equal(p.payload.materials.filter(x=>x.ref.id==='source').length,1);
  assert.equal(p.messages[1].content.split(s.store.read('source').body).length-1,1);assert.deepEqual(s.store.uses('source'),[]);
});

test('统一查询实际正文送达后才能成为下一状态依据',t=>{
  const s=seed(setup(t)),r=lookup(s,trace('grounds',[n('readiness')])),p=continuation(s,r);
  assert.ok(p.payload.continuity.recalled.find(x=>x.ref.id==='belief').record.basis);
  assert.equal(p.payload.materials.find(x=>x.ref.id==='source').record.origin,'reported');
  commit(s,{changes:[{id:'new-thought',expectedRevision:0,kind:'appraisal',body:'读到记录后仍应核实实际情况',nature:'reappraisal',basis:{observations:[pin('source')],priorStates:[pin('belief')]}}]},{packet:p});
  assert.equal(s.store.read('new-thought').revision,1);assert.deepEqual(s.store.read('new-thought').basis.priorStates,[pin('belief')]);
});

test('否定、未发生、条件树与过时限定完整保留',t=>{
  const s=seed(setup(t)),r=lookup(s,trace('grounds',[n('readiness')])),p=continuation(s,r);
  const belief=p.payload.continuity.recalled.find(x=>x.ref.id==='belief').record,forecast=p.payload.continuity.recalled.find(x=>x.ref.id==='forecast').record;
  assert.equal(belief.body,s.store.read('belief').body);assert.deepEqual(forecast.mind.when,s.store.read('forecast').mind.when);
  assert.match(p.payload.materials.find(x=>x.ref.id==='source').record.body,/并没有开始施工/);
});

test('种子包放不下给required-overflow，不把目录候选假装已读',t=>{
  const s=seed(setup(t)),r=lookup(s,trace('grounds',[n('readiness')],{maxDepth:0})),full=continuation(s,r);
  let small=null;for(let b=full.bytes-50;b>full.bytes-7000;b-=50){try{const p=continuation(s,r,{budgetBytes:b});if(p.payload.knowledge.presentation.stop==='required-overflow'){small=p;break;}}catch(e){if(e.code!=='INPUT_OVERFLOW')throw e;}}
  assert.ok(small);assert.equal(small.payload.continuity.recalled.length,0);assert.equal(small.payload.knowledge.presentation.presented.length,0);
  assert.throws(()=>commit(s,{changes:[{id:'bad',expectedRevision:0,kind:'appraisal',body:'假装读过',nature:'reappraisal',basis:{priorStates:[pin('readiness')]}}]},{packet:small}),code('UNDELIVERED_BASIS'));
});

test('查询当前观察只交付一次，不再复制成旧经历',t=>{
  const s=setup(t),r=lookup(s,trace('grounds',[n(s.o.id)])),p=continuation(s,r);
  assert.equal(p.payload.materials.length,0);assert.deepEqual(p.payload.knowledge.presentation.alreadyPresent,[n(s.o.id)]);
  assert.equal(p.messages[1].content.split(s.store.read(s.o.id).body).length-1,1);
});

test('短状态卡被按需升级为整条状态，而不是双份正文',t=>{
  const s=seed(setup(t));const residence={id:'r',target:{kind:'state',ref:pin('readiness')},cue:'当前倾向',purposes:[{kind:'active-task',eventIds:[],questionId:null,appliesTo:null}]};
  commit(s,{attention:{...keepAttention(),residency:{upsert:[residence],remove:[]}}},{stateRefs:[pin('readiness')]});
  const r=lookup(s,trace('grounds',[n('readiness')],{maxDepth:0})),p=continuation(s,r);
  assert.equal(p.payload.continuity.foreground.length,1);assert.ok(p.payload.continuity.foreground[0].record);assert.equal(p.payload.continuity.recalled.length,0);
  assert.equal(p.messages[1].content.split(s.store.read('readiness').body).length-1,1);
});

test('查询本身不改状态、驻留、记忆内容或回想权重',t=>{
  const s=seed(setup(t)),d=commit(s,{kind:'lookup',payload:trace('grounds',[n('readiness')])});
  const before=canonical({subject:s.store.read('fixture-person'),state:s.store.read('readiness'),frame:currentFrame(s)});
  const r=s.reader.execute({decision:pin(d.id)});continuation(s,r);
  assert.equal(canonical({subject:s.store.read('fixture-person'),state:s.store.read('readiness'),frame:currentFrame(s)}),before);assert.deepEqual(s.store.uses('source'),[]);
});

test('重复执行幂等，重复查同一代次不扣第二次额度',t=>{
  const s=seed(setup(t)),d=commit(s,{kind:'lookup',payload:trace('grounds',[n('readiness')])}),a=s.reader.execute({decision:pin(d.id)}),again=s.reader.execute({decision:pin(d.id)});
  assert.equal(canonical(a),canonical(again));const b=lookup(s,trace('grounds',[n('readiness')]));assert.equal(b.outcome,'no-progress');assert.equal(b.readPerformed,false);assert.equal(b.reads,1);
});

test('目录分页和普通检索共用预算，开新reader不能清零',t=>{
  const s=seed(setup(t));for(let i=0;i<4;i++)lookup(s,trace('directory',[],{offset:i,scope:[]}));
  const r=lookup(s,{terms:['受控记录']});assert.equal(r.outcome,'budget-stop');assert.equal(r.reads,4);
});

test('目录作用域只是筛选入口，不阻止跨作用域显式追溯',t=>{
  const s=setup(t);s.store.execute({requestId:'cross',commands:[observation('cross','另一个场景'),{op:'write_note',id:'cross-note',expectedRevision:0,kind:'interpretation',change:'new_evidence',body:'跨活动认识',evidence:[pin('cross')],scope:{scenes:['other'],people:[],validFrom:null,validUntil:null}}]});
  const directory=query(s,trace('directory',[],{scope:['other']}));assert.deepEqual(keys(directory),['cross-note']);
  assert.ok(keys(query(s,trace('grounds',[n('cross-note')]))).includes('cross'));
});

test('目录翻页源变化显式报告，不拼接两代目录',t=>{
  const s=seed(setup(t)),first=lookup(s,trace('directory',[],{maxNodes:1}));assert.ok(first.nextOffset);
  s.store.execute({requestId:'new-source',commands:[observation('new-source','新来源')]});const r=lookup(s,{pageAfter:pin(first.id)});assert.equal(r.outcome,'source-changed');assert.equal(r.readPerformed,false);
});

test('多轮查询后库更新会重新查，但不自动把旧引用换成最新版',t=>{
  const s=seed(setup(t)),a=lookup(s,trace('grounds',[n('readiness')]));
  s.store.execute({requestId:'new-source',commands:[observation('new-source','新来源')]});const b=lookup(s,trace('grounds',[n('readiness')]));assert.equal(b.readPerformed,true);assert.notEqual(a.epoch,b.epoch);assert.deepEqual(b.novelNodes,[]);
});

test('操作回执只经progress显式访问，不混入个人经历目录',t=>{
  const s=setup(t),d=commit(s,{kind:'act',payload:{tool:'fixture.repair',args:{}}},{allowedActionTools:['fixture.repair']});
  s.store.execute({requestId:'receipt',commands:[{op:'record_receipt',actionId:d.action.id,expectedRevision:1,status:'failed',eventId:'receipt',body:'受控工具失败',actor:'fixture-tool',source:{system:'fixture',key:'receipt'}}]});
  const r=query(s,trace('progress',[n('workspace')]));assert.ok(keys(r).includes(d.action.id));assert.ok(keys(r).includes('receipt'));
  const directory=query(s,trace('directory',[],{maxNodes:16}),{maxNodes:16});assert.ok(!keys(directory).includes(d.action.id));assert.ok(!keys(directory).includes(d.id));
});

test('原始版本与索引在失败事务中共同回滚',t=>{
  const s=setup(t),before=canonical(query(s,trace('directory',[])));
  assert.throws(()=>s.store.execute({requestId:'rollback',commands:[observation('rolled-back','不能留下'),{op:'unknown'}]}));
  assert.equal(s.store.read('rolled-back'),null);assert.equal(canonical(query(s,trace('directory',[]))),before);
});

test('索引重建可恢复同样的关系，不改来源、状态、uses或预算',t=>{
  const s=seed(setup(t)),before=query(s,trace('grounds',[n('readiness')]));
  const originals=canonical([...s.store.all('event'),...s.store.all('note'),...s.store.all('personal_state')]);
  s.store.execute({requestId:'rebuild',commands:[{op:'rebuild_graph_index'}]});const after=query(s,trace('grounds',[n('readiness')]));
  assert.ok(after.epoch>before.epoch);assert.equal(canonical({...before,epoch:0}),canonical({...after,epoch:0}));
  assert.equal(canonical([...s.store.all('event'),...s.store.all('note'),...s.store.all('personal_state')]),originals);
  assert.deepEqual(s.store.integrity(),{database:'ok',foreignKeyViolations:0,missingHeads:0});
});

test('schema6必须显式迁移，重建后历史与索引都能读到',t=>{
  let store=null;t.after(()=>store?.close());const path=disk(t);store=new ContinuityStore(path);const s=seed(graphFixture(store));
  const before=canonical(store.read('readiness'));store.close();const DB=sqlite.Database??sqlite.DatabaseSync,raw=new DB(path);
  raw.exec('DROP TABLE graph_tags; DROP TABLE graph_edges; DROP TABLE graph_nodes; DROP TABLE graph_meta; PRAGMA user_version=6');raw.close();
  assert.throws(()=>new ContinuityStore(path),code('MIGRATION_REQUIRED'));store=new ContinuityStore(path,{migrateV6:true});assert.equal(canonical(store.read('readiness')),before);
  assert.ok(keys(store.graphTrace({subjectId:'fixture-person',query:trace('grounds',[n('readiness')]).trace})).includes('source'));
});

test('第二个主体不能借索引读到另一主体的私有状态对象',t=>{
  const s=seed(setup(t));s.store.execute({requestId:'other',commands:[{op:'initialize_subject',id:'other',maxForeground:8}]});
  assert.equal(s.store.readGraphNode({subjectId:'other',ref:n('readiness')}),null);
  assert.equal(s.store.graphTrace({subjectId:'other',query:trace('grounds',[n('readiness')]).trace}).stop,'not-found');
});

test('节点引用、字段、范围不合法时结构性拒绝',()=>{
  for(const q of [trace('unknown',[n('x')]),trace('grounds',[]),trace('directory',[n('x')]),trace('grounds',[n('x')],{maxDepth:7}),trace('grounds',[n('x')],{extra:true})])assert.throws(()=>traceQuery(q.trace));
  assert.throws(()=>nodeKey({kind:'process',id:'x',revision:1}));assert.throws(()=>nodeKey(n('x',0)));
});

test('目录元数据字节上限发生裁剪时不跳过未交付条目',t=>{
  const s=seed(setup(t)),all=query(s,trace('directory',[],{maxNodes:16}),{maxNodes:16});
  let offset=0,seen=[];for(let i=0;i<30;i++){
    const r=query(s,trace('directory',[],{offset,maxBytes:1800,maxNodes:16}),{maxNodes:16});assert.ok(Buffer.byteLength(canonical(r))<=1800);
    seen.push(...r.nodes.map(x=>nodeKey(x.ref)));if(r.nextOffset===null)break;assert.ok(r.nextOffset>offset);offset=r.nextOffset;
  }
  assert.deepEqual([...new Set(seen)].sort(),all.nodes.map(x=>nodeKey(x.ref)).sort());assert.equal(seen.length,new Set(seen).size);
});

test('边扫描上限、乘积状态和循环都有界',()=>{
  const nodes=Array.from({length:10},(_,i)=>({ref:n(`v${i}`),owner:pin(`v${i}`)}));
  const edges=nodes.flatMap((a,i)=>nodes.map((b,j)=>({key:`${i}-${j}`,from:a.ref,to:b.ref,family:'basis',relation:'evidence',usable:true,symmetric:false,owner:a.owner})));
  const r=walkKnowledgeGraph(trace('grounds',[n('v0')],{maxNodes:16,maxDepth:6}).trace,{epoch:1,maxNodes:16,maxEdges:12,
    load:ref=>nodes.find(x=>nodeKey(x.ref)===nodeKey(ref)),neighbors:x=>edges.filter(e=>nodeKey(e.from)===nodeKey(x.ref)).map(edge=>({edge,direction:'out',other:edge.to}))});
  assert.equal(r.checkedEdges,12);assert.ok(r.limits.includes('edge-limit'));assert.equal(new Set(r.nodes.map(x=>nodeKey(x.ref))).size,r.nodes.length);
});

test('状态机按阶段限制mind跳转，未实现语义不伪装算法',()=>{
  const e={family:'mind',relation:'concerns',usable:true};assert.equal(traceTransition('grounds','focus',e,'out'),'context');assert.equal(traceTransition('grounds','evidence',e,'out'),null);
  assert.equal(traceTransition('grounds','context',{...e,relation:'condition-input'},'out'),'context');
  assert.equal(traceTransition('grounds','focus',{family:'association',relation:'similar',usable:true},'out'),null);
});

test('装配是可检验的完整包贪心基线，不宣称背包最优解',()=>{
  const entries=['a','b','c'].map(id=>({ref:n(id)}));let renders=0;
  const result=assembleGraphPackages({traces:[{query:trace('grounds',[n('a')]),trace:{nodes:entries}}],render:(nodes,presentation)=>{
    renders++;if(nodes.length>2)throw Object.assign(new Error('too large'),{code:'INPUT_OVERFLOW'});return {nodes,presentation};}});
  assert.deepEqual(result.nodes.map(x=>x.ref.id),['a','b']);assert.equal(result.presentation.omitted.length,1);assert.equal(result.presentation.semanticSufficiency,'not-established');assert.ok(renders<=6);
});

test('小集合穷举暴露贪心的实际差距，不用漂亮名称掩盖次优',()=>{
  const costs={seed:0,a:3,b:2,c:2},entries=Object.keys(costs).map(id=>({ref:n(id)})),cap=4;
  const p=assembleGraphPackages({traces:[{query:trace('grounds',[n('seed')]),trace:{nodes:entries}}],render:(nodes,presentation)=>{
    if(nodes.reduce((sum,x)=>sum+costs[x.ref.id],0)>cap)throw Object.assign(new Error('budget'),{code:'INPUT_OVERFLOW'});return {nodes,presentation};}});
  let optimum=0;for(let mask=0;mask<8;mask++){const subset=['a','b','c'].filter((_,i)=>mask&(1<<i));if(subset.reduce((sum,k)=>sum+costs[k],0)<=cap)optimum=Math.max(optimum,subset.length);}
  assert.equal(p.nodes.length-1,1);assert.equal(optimum,2);assert.equal(p.presentation.algorithm,'purpose-ordered-complete-packages-v1');
});

test('按需交付隐藏过程后才能修改，历史帧正文不授权修改现行过程',t=>{
  const s=seed(setup(t)),process=(id,expectedRevision=0)=>({id,expectedRevision,label:id,body:`过程 ${id}`,status:'active',world:'actual',intervals:[{start:null,end:null}],basis:[]});
  commit(s,{attention:{...keepAttention(),processes:Array.from({length:16},(_,i)=>process(`task-${String(i).padStart(2,'0')}`))}});
  const f=currentFrame(s),target=processNode(f,pin('task-15'));
  assert.ok(!prepare(s).payload.continuity.attention.processes.some(p=>p.id==='task-15'));
  const result=lookup(s,trace('progress',[target],{maxDepth:0})),p=continuation(s,result);
  assert.ok(p.payload.knowledge.cards.some(c=>c.ref.id==='task-15'&&c.record.body==='过程 task-15'));
  commit(s,{attention:{...keepAttention(),processes:[{...process('task-15',1),status:'paused'}]}},{packet:p});
  assert.equal(currentFrame(s).processes.find(p=>p.id==='task-15').status,'paused');
  const old=lookup(s,trace('progress',[target],{maxDepth:0})),oldInput=continuation(s,old);
  assert.equal(oldInput.payload.knowledge.cards[0].historical,true);
  assert.throws(()=>commit(s,{attention:{...keepAttention(),processes:[process('task-15',2)]}},{packet:oldInput}),code('UNREAD_PROCESS'));
});

test('完整messages字节精确计费，种子和来源不按重复路径重复计费',t=>{
  const s=seed(setup(t)),r=lookup(s,trace('grounds',[n('belief'),n('note')])),p=continuation(s,r);
  assert.equal(p.bytes,Buffer.byteLength(canonical(p.messages)));assert.equal(p.unit,'utf8-bytes');
  assert.equal(continuation(s,r,{budgetBytes:p.bytes}).packetId,p.packetId);
  const smaller=continuation(s,r,{budgetBytes:p.bytes-1});assert.ok(smaller.bytes<=p.bytes-1);assert.ok(smaller.payload.knowledge.presentation.omitted.length>0);
});

test('索引不向已有来源ID额外施加短标识约束',t=>{
  const s=setup(t),id='legacy-'+('long-identifier-'.repeat(25));s.store.execute({requestId:'long-source',commands:[observation(id,'保留原标识，不为建立索引改写原事件')]});
  assert.ok(keys(query(s,trace('grounds',[n(id)]))).includes(id));
});

test('重启后查询回执可继续装配与提交，不重复调用模型',async t=>{
  let store=null;t.after(()=>store?.close());const path=disk(t);store=new ContinuityStore(path);const s=seed(graphFixture(store));
  let calls=0;const options={requestId:'invoke-once',decisionId:'invoke-once',currentEvent:s.o,workspace:s.w,mind:true,unified:true,
    localLookupPolicy:policy,budgetBytes:131072,invoke:async input=>{calls++;return proposal(input,{kind:'lookup',payload:trace('grounds',[n('readiness')])});}};
  const a=await s.session.run(options);const result=s.reader.execute({decision:pin(a.decision.id)});store.close();store=new ContinuityStore(path);
  const restarted=new ContinuitySession({store,subjectId:'fixture-person',attention:true}),b=await restarted.run(options);
  assert.equal(calls,1);assert.equal(b.modelCalled,false);assert.equal(b.resumed,true);
  const p=restarted.prepare({currentEvent:s.o,workspace:s.w,mind:true,unified:true,localLookupPolicy:policy,budgetBytes:131072,lookupResults:[pin(result.id)]});
  assert.ok(p.payload.materials.some(m=>m.ref.id==='source'));assert.ok(p.payload.knowledge.paths.length>0);
});

test('查询后关系被废弃时，旧路径交付明确标历史而非当前有效',t=>{
  const s=setup(t);s.store.execute({requestId:'link',commands:[link('sim','note','source')]});
  const r=lookup(s,trace('associations',[n('note')]));s.store.execute({requestId:'retire',commands:[link('sim','note','source','similar',{expectedRevision:1,status:'retired'})]});
  const p=continuation(s,r);assert.ok(p.payload.knowledge.paths.every(e=>e.historicalAtDelivery));assert.ok(p.payload.information.results[0].asOf);
});
