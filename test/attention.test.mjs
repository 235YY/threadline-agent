import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {attentionId,keepAttention,expandEvents,activeRelations} from '../src/attention.mjs';
import {claimResponse,recordResponseDelivery,readPersonalState} from '../src/continuity.mjs';
import {verifiedModelInput} from '../src/cognition.mjs';
import {canonical} from '../src/contracts.mjs';
import * as sqlite from 'node:sqlite';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {memory,disk,put,event,frame,ref,code} from './helpers.mjs';

const policy={maxReads:4,maxHits:4};
function setup(t,{path=null,attention=true,maxForeground=8}={}){
  const store=path?new ContinuityStore(path,{clock:()=>2000}):memory(t).store;if(path)t.after(()=>store.close());
  const session=new ContinuitySession({store,subjectId:'person',attention,maxForeground});
  const [o,w]=put(store,'initial',event('o1'),frame());return {store,session,o,w,seq:1};
}
const state=(id,body='仍有一点失落',fields={})=>({id,expectedRevision:0,kind:'feeling',body,status:'open',nature:'self-report',...fields});
const process=(id,fields={})=>({id,expectedRevision:0,label:id,body:`过程 ${id}`,status:'active',world:'actual',intervals:[{start:null,end:null}],basis:[],...fields});
const relation=(id,from,to,type='task-part-of',fields={})=>({id,expectedRevision:0,type,from:{id:from,revision:1},to:{id:to,revision:1},status:'active',basis:[],...fields});
const purpose=(kind,fields={})=>({kind,eventIds:[],questionId:null,appliesTo:null,...fields});
const residence=(id,target,kind='state',purposes=[purpose('self-directed')])=>({id,target:{kind,ref:{id:target,revision:1}},cue:`入口 ${target}`,purposes});
const question=(id,op='open',fields={})=>({id,expectedRevision:0,op,text:'你想吃什么',awaitingResponseFrom:'brother',responseEvent:null,...fields});
function prepare(s,fields={}){return s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,budgetBytes:65536,...fields});}
function output(packet,{changes=[],attention=keepAttention(),kind='wait',payload={},residency={add:[],remove:[]}}={}){
  return {packetId:packet.packetId,options:[{id:'a',kind,payload}],selected:'a',summary:'手工给定的结构测试，不是模型心理或语义证据',used:[],
    continuity:{changes,residency,expressionChoice:null,observationDisposition:'handled',attention}};
}
function commit(s,fields={},packet=prepare(s)){
  const id=`d${++s.seq}`;return s.session.commit({packet,output:output(packet,fields),decisionId:id,requestId:`commit:${id}`});
}
function next(s,fields={}){const id=`o${++s.seq}`;[s.o]=put(s.store,`append:${id}`,event(id,fields));return s;}
function snapshot(s){return s.store.read(attentionId('person'));}
function sent(s,decision,outcome='sent'){
  const r=s.store.read(`${decision.id}:response`),claimId=`claim:${r.id}`;
  const claimed=claimResponse({store:s.store,response:ref(r),claimId,worker:'controlled-test',requestId:claimId});
  return recordResponseDelivery({store:s.store,response:ref(claimed),claimId,outcome,eventId:`receipt:${r.id}`,body:'受控发送回执，无实际外发',source:{system:'controlled-test',key:r.id},actor:'sender',requestId:`delivery:${r.id}`});
}
const patch=extra=>({...keepAttention(),...extra});
const query=(seeds,route='parents',extra={})=>({graph:{seeds,route,maxDepth:2,maxNodes:4,offset:0,need:'检查此过程关联的当前结构',...extra}});

test('新协议提供精确模型输入，且不残留自动进前台的旧指令',t=>{
  const s=setup(t),p=prepare(s);assert.equal(p.stage,'decisionAttention');assert.equal(p.payload.format,'jingyang-decision-attention-v1');
  assert.deepEqual(verifiedModelInput(p).messages,p.messages);assert.equal(p.instruction.includes('修改中的开放对象会进入前台'),false);
  assert.equal(p.instruction.includes('continuity严格包含changes、residency、expressionChoice、observationDisposition。'),false);
  assert.ok(p.payload.memoryAccess.routes.includes('graph'));assert.ok(p.payload.memoryAccess.routes.includes('stateRef'));
});
test('只保存新感受和意图不会自动驻留，但可固定版本读回',t=>{
  const s=setup(t);commit(s,{changes:[state('mood'),state('plan','想造小屋',{kind:'intention'})]});
  const p=prepare(next(s));assert.deepEqual(p.payload.continuity.foreground,[]);assert.deepEqual(snapshot(s).residences,[]);
  assert.match(readPersonalState({store:s.store,subjectId:'person',state:{id:'mood',revision:1}}).record.body,/失落/);
});
test('入口与必要正文分开，未展开的状态不能直接修订',t=>{
  const s=setup(t);commit(s,{changes:[state('mood')],attention:patch({residency:{upsert:[residence('r','mood')],remove:[]}})});
  const p=prepare(next(s));assert.equal(p.payload.continuity.foreground.length,0);assert.equal(p.payload.continuity.attention.entries.length,1);
  assert.equal(p.payload.continuity.attention.entries[0].body,undefined);
  assert.throws(()=>commit(s,{changes:[state('mood','好一些',{expectedRevision:1})]},p),code('UNREAD_STATE'));
  assert.equal(s.store.read('mood').revision,1);
});
test('stateRef实际查询进入下一输入，查询与展示不强化记忆',t=>{
  const s=setup(t);commit(s,{changes:[state('mood')]});next(s);
  const d=commit(s,{kind:'lookup',payload:{stateRef:{id:'mood',revision:1}}});
  const reader=new LocalLookupSession({store:s.store,subjectId:'person',policy}),result=reader.execute({decision:ref(d)});
  assert.equal(result.method,'own-state-pinned-read');const p=prepare(s,{lookupResults:[ref(result)]});
  assert.equal(p.payload.continuity.recalled[0].body,'仍有一点失落');assert.equal(s.store.read('mood').revision,1);assert.deepEqual(s.store.uses('mood'),[]);
  commit(s,{changes:[state('mood','想开一点了',{expectedRevision:1,nature:'reappraisal'})]},p);assert.equal(s.store.read('mood').revision,2);
});
test('本轮影响的用途不自动成为下一轮必要正文，感受没有被清除',t=>{
  const s=setup(t);commit(s,{changes:[state('mood')],attention:patch({residency:{upsert:[residence('r','mood','state',[purpose('affects-current-choice',{appliesTo:ref(s.o)})])],remove:[]}})});
  const same=prepare(s);assert.equal(same.payload.continuity.foreground.length,1);
  const changed=prepare(next(s));assert.equal(changed.payload.continuity.foreground.length,0);assert.equal(changed.payload.continuity.attention.entries.length,1);
  assert.equal(s.store.read('mood').body,'仍有一点失落');
});
test('显式驻留同目标多个用途不重复交付正文',t=>{
  const s=setup(t);commit(s,{changes:[state('task','修好屋顶',{kind:'activity'})],attention:patch({residency:{upsert:[
    residence('a','task','state',[purpose('active-task')]),residence('b','task')],remove:[]}})});
  const p=prepare(next(s));assert.equal(p.payload.continuity.foreground.length,1);assert.equal(p.payload.continuity.attention.entries.length,0);
});
test('self-directed没有超时清零；显式退后台不改正文和历史',t=>{
  const s=setup(t);commit(s,{changes:[state('wish','想拥有身体',{kind:'intention'})],attention:patch({residency:{upsert:[residence('r','wish')],remove:[]}})});
  const old=canonical(s.store.read('wish'));commit(next(s));assert.equal(snapshot(s).residences.length,1);
  commit(next(s),{attention:patch({residency:{upsert:[],remove:['r']}})});assert.equal(snapshot(s).residences.length,0);assert.equal(canonical(s.store.read('wish')),old);
});
test('修改既有必要状态跟随新版本，但新状态不会顺带进入前台',t=>{
  const s=setup(t);commit(s,{changes:[state('activity','盖房',{kind:'activity'})],attention:patch({residency:{upsert:[residence('r','activity','state',[purpose('active-task')])],remove:[]}})});
  commit(next(s),{changes:[state('activity','修屋顶',{kind:'activity',expectedRevision:1}),state('extra')]});
  assert.deepEqual(snapshot(s).residences[0].target.ref,{id:'activity',revision:2});assert.equal(snapshot(s).residences.length,1);
  assert.equal(prepare(next(s)).payload.continuity.foreground[0].body,'修屋顶');
  assert.equal(prepare(s).payload.continuity.attention.residences[0].cueHistorical,true);
});
test('容量溢出整体回滚并保留提案，不静默踢走状态',t=>{
  const s=setup(t,{maxForeground:1}),p=prepare(s);
  assert.throws(()=>commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[residence('ra','a'),residence('rb','b')],remove:[]}})},p),code('FOREGROUND_CAPACITY'));
  assert.equal(s.store.read('a'),null);assert.equal(s.store.read('b'),null);assert.equal(snapshot(s).residences.length,0);
  assert.equal(s.store.read(`d${s.seq}:attempt`).status,'captured');assert.equal(s.store.read(`d${s.seq}:response`),null);
});
test('非空旧前台拒绝自动开启，不清掉旧感受',t=>{
  const s=setup(t,{attention:false}),p=prepare(s),out=output(p,{changes:[state('mood')]});delete out.continuity.attention;
  s.session.commit({packet:p,output:out,decisionId:'old',requestId:'old'});
  assert.throws(()=>new ContinuitySession({store:s.store,subjectId:'person',attention:true}),code('ATTENTION_MIGRATION_REQUIRED'));
  assert.equal(s.store.read('person').foreground.length,1);assert.equal(s.store.read(attentionId('person')),null);
});
test('并行、多父与父子关系可以同时持久保存；混合图允许因果环',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:['rail','company','bridge','chat','smelt'].map(id=>process(id)),relations:[
    relation('r1','bridge','rail'),relation('r2','bridge','company'),relation('r3','chat','smelt','overlaps'),relation('r4','rail','company','causes'),relation('r5','company','rail','causes')]})});
  assert.equal(snapshot(s).relations.length,5);assert.equal(prepare(next(s)).payload.continuity.attention.relations.length,5);
});
test('包含环拒绝，事务不留下部分过程或关系',t=>{
  const s=setup(t);assert.throws(()=>commit(s,{attention:patch({processes:[process('a'),process('b')],relations:[relation('ab','a','b'),relation('ba','b','a')]})}),code('PART_CYCLE'));
  assert.equal(snapshot(s).processes.length,0);
});
test('actual/possible禁止包含混用、禁止把可能动作标成完成',t=>{
  const s=setup(t);assert.throws(()=>commit(s,{attention:patch({processes:[process('actual'),process('plan',{world:'possible'})],relations:[relation('r','plan','actual')]})}),code('BRANCH_MIX'));
  assert.throws(()=>commit(s,{attention:patch({processes:[process('plan',{world:'possible',status:'completed'})]})}),code('POSSIBILITY_NOT_RECEIPT'));
  assert.equal(snapshot(s).processes.length,0);
});
test('实际思想和其中可能的动作分开，realizes不把其他分支变实际',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('planning'),process('hill',{world:'possible'}),process('river',{world:'possible'}),process('actual-house')],relations:[relation('realized','actual-house','river','realizes')]})});
  const f=snapshot(s);assert.equal(f.processes.find(p=>p.id==='hill').world,'possible');assert.equal(f.processes.find(p=>p.id==='river').world,'possible');
  assert.equal(f.relations[0].type,'realizes');
  assert.throws(()=>commit(next(s),{attention:patch({processes:[process('hill',{expectedRevision:1,world:'actual'})]})}),code('PROCESS_WORLD'));
});
test('暂停子过程不暂停父过程或清除愿望、感受，恢复点明确保存',t=>{
  const s=setup(t);commit(s,{changes:[state('wish','想修好家',{kind:'intention'}),state('mood')],attention:patch({processes:[process('home'),process('supply')],relations:[relation('part','supply','home')],residency:{upsert:[residence('supply-r','supply','process',[purpose('active-task'),purpose('self-directed')])],remove:[]}})});
  const parent=canonical(snapshot(s).processes.find(p=>p.id==='home')),wish=canonical(s.store.read('wish')),mood=canonical(s.store.read('mood'));
  commit(next(s),{attention:patch({processes:[process('supply',{expectedRevision:1,status:'paused'})],residency:{upsert:[{...residence('supply-r','supply','process',[purpose('recovery-point'),purpose('self-directed')]),target:{kind:'process',ref:{id:'supply',revision:2}}}],remove:[]}})});
  assert.equal(canonical(snapshot(s).processes.find(p=>p.id==='home')),parent);assert.equal(canonical(s.store.read('wish')),wish);assert.equal(canonical(s.store.read('mood')),mood);
  assert.ok(snapshot(s).residences[0].purposes.some(p=>p.kind==='recovery-point'));assert.equal(prepare(next(s)).payload.continuity.attention.residences[0].delivery,'entry');
});
test('端点更新不暗中改接关系：旧关系可追溯并标待复核',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('a'),process('b')],relations:[relation('ab','a','b')]})});
  const old=snapshot(s);commit(next(s),{attention:patch({processes:[process('a',{expectedRevision:1,status:'paused'})]})});
  assert.equal(activeRelations(snapshot(s)).length,0);assert.equal(snapshot(s).relations[0].from.revision,1);assert.equal(s.store.read(old.id,old.revision).processes[0].revision,1);
  assert.equal(prepare(next(s)).payload.continuity.attention.staleRelations.length,1);
});
test('暂停只退出active-task用途，另一个self-directed关注仍保留',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('p')],residency:{upsert:[residence('r','p','process',[purpose('active-task'),purpose('self-directed')])],remove:[]}})});
  commit(next(s),{attention:patch({processes:[process('p',{expectedRevision:1,status:'paused'})]})});
  assert.deepEqual(snapshot(s).residences[0].purposes.map(p=>p.kind),['self-directed']);assert.equal(snapshot(s).residences[0].target.ref.revision,2);
});
test('新问题绑定回复意图；没选respond不能制造已问问题',t=>{
  const s=setup(t);assert.throws(()=>commit(s,{attention:patch({questions:[question('q')]})}),code('QUESTION_UNSENT'));
  assert.equal(snapshot(s).questions.length,0);const d=commit(s,{kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')]})});
  const q=prepare(next(s)).payload.continuity.attention.questions[0];assert.equal(q.attempts[0].status,'pending');assert.equal(q.attempts[0].askedAt,null);assert.equal(q.attempts[0].ref.id,`${d.id}:response`);
});
test('确认发送不自动回答；无关新消息不关闭问题',t=>{
  const s=setup(t),d=commit(s,{kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')]})});sent(s,d);
  const p=prepare(next(s,{body:'今天楼下桂花开了'}));assert.equal(p.payload.continuity.attention.questions[0].status,'open');
  assert.equal(p.payload.continuity.attention.questions[0].attempts[0].status,'sent');assert.equal(p.payload.continuity.attention.questions[0].attempts[0].askedAt,2000);
  commit(s,{},p);assert.equal(snapshot(s).questions[0].status,'open');
});
test('发送失败和未知送达都不能当作得到回答',t=>{
  for(const outcome of ['failed','unknown']){
    const s=setup(t),d=commit(s,{kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')]})});sent(s,d,outcome);
    next(s,{body:'面条'});assert.throws(()=>commit(s,{attention:patch({questions:[question('q','handle',{expectedRevision:1,responseEvent:ref(s.o)})]})}),code('QUESTION_UNSENT'));
    assert.equal(snapshot(s).questions[0].status,'open');
  }
});
test('相关回答显式处理，结束等待用途不删除独立心情',t=>{
  const s=setup(t),d=commit(s,{changes:[state('mood')],kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')],residency:{upsert:[residence('r','mood','state',[purpose('awaiting-reply',{questionId:'q'}),purpose('self-directed')])],remove:[]}})});sent(s,d);
  next(s,{body:'想吃面条'});commit(s,{attention:patch({questions:[question('q','handle',{expectedRevision:1,responseEvent:ref(s.o)})]})});
  assert.equal(snapshot(s).questions[0].status,'handled');assert.deepEqual(snapshot(s).residences[0].purposes.map(p=>p.kind),['self-directed']);assert.equal(s.store.read('mood').revision,1);
});
test('发送回执和其他人的消息都不能冒充所等之人的答案',t=>{
  const s=setup(t),d=commit(s,{kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')]})}),receipt=sent(s,d);
  next(s,{actor:'friend',body:'面条'});assert.throws(()=>commit(s,{attention:patch({questions:[question('q','handle',{expectedRevision:1,responseEvent:ref(s.o)})]})}),code('QUESTION_RESPONSE'));
  next(s);const p=prepare(s,{materials:[{ref:ref(s.store.read(receipt.receipts[0].id)),aspect:'experience'}]});
  assert.throws(()=>commit(s,{attention:patch({questions:[question('q','handle',{expectedRevision:1,responseEvent:receipt.receipts[0]})]})},p),code('QUESTION_RESPONSE'));
});
test('追问沿用一个问题，保留不同发送尝试而不重发旧回复',t=>{
  const s=setup(t),first=commit(s,{kind:'respond',payload:{text:'你想吃什么'},attention:patch({questions:[question('q')]})});sent(s,first);
  const second=commit(next(s),{kind:'respond',payload:{text:'所以吃什么呀'},attention:patch({questions:[question('q','followup',{expectedRevision:1})]})});
  assert.equal(snapshot(s).questions.length,1);assert.equal(snapshot(s).questions[0].attempts.length,2);
  assert.equal(s.store.read(`${first.id}:response`).status,'sent');assert.equal(s.store.read(`${second.id}:response`).status,'pending');
});
test('发送状态在模型思考时变化会拒绝过期提案，问题不被误关闭',t=>{
  const s=setup(t),d=commit(s,{kind:'respond',payload:{text:'吃什么'},attention:patch({questions:[question('q')]})});
  next(s);const p=prepare(s);sent(s,d);assert.throws(()=>commit(s,{},p),code('STALE_DELIVERY'));assert.equal(snapshot(s).questions[0].status,'open');
});
test('关系展开与关键词共用持久次数，重复读不会重置额度',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('child'),process('parent')],relations:[relation('p','child','parent')]})});next(s);
  const reader=new LocalLookupSession({store:s.store,subjectId:'person',policy}),d=commit(s,{kind:'lookup',payload:query(['child'])});
  const result=reader.execute({decision:ref(d)});assert.deepEqual(result.graph.nodes.map(n=>n.id).sort(),['child','parent']);assert.equal(result.remainingReads,3);
  const p=prepare(s,{lookupResults:[ref(result)]});assert.equal(p.payload.information.results[0].graph.kind,'lookup');
  assert.equal(snapshot(s).residences.length,0);assert.deepEqual(s.store.uses(s.o.id),[]);
  const d2=commit(s,{kind:'lookup',payload:{terms:['不会命中']}},p),r2=reader.execute({decision:ref(d2)});assert.equal(r2.remainingReads,2);
});
test('父级查询不折返遍历兄弟或全生活，截断有明确原因',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:['life','home','child','sibling'].map(id=>process(id)),relations:[relation('a','child','home'),relation('b','home','life'),relation('c','sibling','home')]})});
  const f=snapshot(s),result=expandEvents(f,query(['child']).graph);
  assert.deepEqual(result.nodes.map(n=>n.id),['child','home','life']);assert.ok(!result.nodes.some(n=>n.id==='sibling'));
  assert.ok(expandEvents(f,query(['child'],'parents',{maxDepth:0}).graph).truncated.includes('depth-limit'));
  assert.ok(expandEvents(f,query(['child'],'parents',{maxNodes:1}).graph).truncated.includes('node-limit'));
});
test('相似边不混入任务包含路线，关系环不会无限扩展',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:['a','b','c'].map(id=>process(id)),relations:[relation('ab','a','b','similar'),relation('bc','b','c','similar'),relation('ca','c','a','similar')]})});
  assert.equal(expandEvents(snapshot(s),query(['a']).graph).nodes.length,1);
  assert.equal(expandEvents(snapshot(s),query(['a'],'associations').graph).nodes.length,3);
});
test('图读取预算与目录分页可核对，未知种子不能伪装为空结果',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:['a','b','c'].map(id=>process(id))})});
  const q=query([],'directory',{maxNodes:1}).graph,a=expandEvents(snapshot(s),q),b=expandEvents(snapshot(s),{...q,offset:a.nextOffset});
  assert.equal(a.nodes.length,1);assert.notEqual(a.nodes[0].id,b.nodes[0].id);assert.equal(a.total,3);
  assert.throws(()=>expandEvents(snapshot(s),query(['unknown']).graph),code('GRAPH_SEED'));
  assert.throws(()=>expandEvents(snapshot(s),query(['a'],'parents',{maxDepth:100}).graph),code('GRAPH_LIMIT'));
});
test('同图重复查询返回no-progress，重放不重复花费读取次数',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('p')]})});next(s);
  const reader=new LocalLookupSession({store:s.store,subjectId:'person',policy}),d1=commit(s,{kind:'lookup',payload:query(['p'])}),r1=reader.execute({decision:ref(d1)});
  assert.deepEqual(reader.execute({decision:ref(d1)}),r1);
  const d2=commit(s,{kind:'lookup',payload:query(['p'])},prepare(s,{lookupResults:[ref(r1)]})),r2=reader.execute({decision:ref(d2)});
  assert.equal(r2.outcome,'no-progress');assert.equal(r2.reads,1);assert.equal(r2.readPerformed,false);
});
test('预算限制精确作用于完整输入，不静默删除必需内容',t=>{
  const s=setup(t);const before=canonical(snapshot(s));assert.throws(()=>prepare(s,{budgetBytes:100}),code('INPUT_OVERFLOW'));assert.equal(canonical(snapshot(s)),before);
});
test('旧帧不能覆盖新决定，非法用途整体回滚且保留提案',t=>{
  const s=setup(t),old=prepare(s);commit(s,{attention:patch({processes:[process('new')]})});
  assert.throws(()=>commit(s,{},old),code('STALE_SUBJECT'));
  assert.throws(()=>commit(next(s),{changes:[state('m')],attention:patch({residency:{upsert:[residence('r','m','state',[purpose('fake')])],remove:[]}})}));
  assert.equal(s.store.read('m'),null);assert.equal(snapshot(s).residences.length,0);
});
test('重启恢复事件拓扑、后台入口和未解决问题',t=>{
  const path=disk(t),s=setup(t,{path});commit(s,{changes:[state('mood')],kind:'respond',payload:{text:'你想吃什么'},attention:patch({processes:[process('p')],questions:[question('q')],residency:{upsert:[residence('r','mood')],remove:[]}})});
  const before=canonical(snapshot(s));s.store.close();const reopened=new ContinuityStore(path);t.after(()=>reopened.close());
  const session=new ContinuitySession({store:reopened,subjectId:'person',attention:true}),p=session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});
  assert.equal(canonical(reopened.read(attentionId('person'))),before);assert.equal(p.payload.continuity.attention.questions[0].attempts[0].status,'pending');
  assert.equal(p.payload.continuity.attention.entries[0].ref.id,'mood');assert.deepEqual(reopened.integrity(),{database:'ok',foreignKeyViolations:0,missingHeads:0});reopened.close();
});

test('过期关系可显式修订到新端点，原关系版本仍可追溯',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('a'),process('b')],relations:[relation('ab','a','b')]})});
  commit(next(s),{attention:patch({processes:[process('a',{expectedRevision:1,status:'paused'})]})});
  const old=snapshot(s);commit(next(s),{attention:patch({relations:[relation('ab','a','b','task-part-of',{expectedRevision:1,from:{id:'a',revision:2}})]})});
  assert.equal(activeRelations(snapshot(s)).length,1);assert.equal(s.store.read(old.id,old.revision).relations[0].from.revision,1);
});
test('挂起、恢复和取消同一问题不伪造回答，不动独立状态',t=>{
  const s=setup(t);commit(s,{changes:[state('m')],kind:'respond',payload:{text:'吃什么'},attention:patch({questions:[question('q')]})});
  const mood=canonical(s.store.read('m'));
  commit(next(s),{attention:patch({questions:[question('q','suspend',{expectedRevision:1})]})});assert.equal(snapshot(s).questions[0].status,'suspended');
  commit(next(s),{attention:patch({questions:[question('q','resume',{expectedRevision:2})]})});assert.equal(snapshot(s).questions[0].status,'open');
  commit(next(s),{attention:patch({questions:[question('q','cancel',{expectedRevision:3})]})});assert.equal(snapshot(s).questions[0].status,'cancelled');
  assert.equal(snapshot(s).questions[0].responseEvent,null);assert.equal(canonical(s.store.read('m')),mood);
});
test('不同环境仍能读取自己的后台状态和旧版本，不作隐私断档',t=>{
  const s=setup(t);commit(s,{changes:[state('m','在MC里有点烦',{scope:['mc']})]});
  const [w]=put(s.store,'another-workspace',frame({id:'mc',scene:'mc:world'}));s.w=w;next(s,{scene:'mc:world'});
  const d=commit(s,{kind:'lookup',payload:{stateRef:{id:'m',revision:1}}}),reader=new LocalLookupSession({store:s.store,subjectId:'person',policy});
  const r=reader.execute({decision:ref(d)}),p=prepare(s,{lookupResults:[ref(r)]});assert.equal(p.payload.continuity.recalled[0].body,'在MC里有点烦');
  commit(s,{changes:[state('m','已经不烦了',{expectedRevision:1,nature:'reappraisal',scope:['mc']})]},p);
  assert.equal(readPersonalState({store:s.store,subjectId:'person',state:{id:'m',revision:1}}).record.body,'在MC里有点烦');
});
test('未知图种子记录具体失败且计入次数，不成为无限免费重试',t=>{
  const s=setup(t),reader=new LocalLookupSession({store:s.store,subjectId:'person',policy});next(s);
  const d=commit(s,{kind:'lookup',payload:query(['no-such-process'])}),r=reader.execute({decision:ref(d)});
  assert.equal(r.outcome,'invalid-target');assert.equal(r.failure.code,'GRAPH_SEED');assert.equal(r.reads,1);
  assert.equal(prepare(s,{lookupResults:[ref(r)]}).payload.information.results[0].failure.code,'GRAPH_SEED');
});
test('多个图方向和关键词查询不能通过换路线绕过共同读取上限',t=>{
  const s=setup(t);commit(s,{attention:patch({processes:[process('a'),process('b')],relations:[relation('r','a','b')]})});next(s);
  const reader=new LocalLookupSession({store:s.store,subjectId:'person',policy});let results=[];
  const queries=[query(['a']),query(['b'],'children'),query([],'directory'),{terms:['none']},query(['a'],'associations')];
  for(let i=0;i<queries.length;i++){
    const d=commit(s,{kind:'lookup',payload:queries[i]},prepare(s,{lookupResults:results})),r=reader.execute({decision:ref(d)});results=[ref(r)];
    assert.equal(r.reads,Math.min(i+1,4));if(i===4)assert.equal(r.outcome,'budget-stop');
  }
});
test('会话完整调用、提交与重入走新协议，模拟客户端只调用一次',async t=>{
  const s=setup(t);let calls=0;
  const args={requestId:'attention-session-turn',decisionId:'session-d',currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,budgetBytes:65536,
    invoke:async actual=>{calls++;const packet={packetId:actual.packetId};return output(packet,{changes:[state('new-state')]});}};
  const first=await s.session.run(args),again=await s.session.run(args);
  assert.equal(first.packet.stage,'decisionAttention');assert.equal(again.modelCalled,false);assert.equal(calls,1);assert.equal(snapshot(s).residences.length,0);
});
test('启用新协议后旧输入不能绕过用途规则，即使主体版本没变',t=>{
  const s=setup(t,{attention:false}),p=prepare(s);new ContinuitySession({store:s.store,subjectId:'person',attention:true});
  const out=output(p);delete out.continuity.attention;
  assert.throws(()=>s.session.commit({packet:p,output:out,decisionId:'old-input',requestId:'old-input'}),code('ATTENTION_REQUIRED'));
  assert.equal(s.store.read('old-input'),null);assert.equal(s.store.read('old-input:attempt').status,'captured');
});
test('两个SQLite连接的过期帧不会覆盖另一边已提交的并行状态',t=>{
  const path=disk(t),s=setup(t,{path}),other=new ContinuityStore(path);t.after(()=>other.close());
  const session=new ContinuitySession({store:other,subjectId:'person',attention:true}),p=session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,budgetBytes:65536});
  commit(s,{attention:patch({processes:[process('new')]})});
  assert.throws(()=>session.commit({packet:p,output:output(p),decisionId:'racing',requestId:'racing'}),code('STALE_SUBJECT'));
  assert.equal(snapshot(s).processes[0].id,'new');other.close();s.store.close();
});
test('100个确定小图的父级查询与独立广度遍历结果一致',()=>{
  let seed=48271;const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  for(let trial=0;trial<100;trial++){
    const processes=Array.from({length:6},(_,i)=>({...process(`n${i}`),revision:1})),relations=[];
    for(let i=0;i<6;i++)for(let j=i+1;j<6;j++)if(random()<0.4)relations.push({...relation(`e${i}-${j}`,`n${i}`,`n${j}`),revision:1});
    const f={id:'f',revision:1,processes,relations},q=query(['n0'],'parents',{maxDepth:4,maxNodes:8}).graph;
    const distances=new Map([['n0',0]]),queue=['n0'];for(let k=0;k<queue.length;k++){
      const id=queue[k];if(distances.get(id)>=4)continue;
      for(const r of relations)if(r.from.id===id&&!distances.has(r.to.id)){distances.set(r.to.id,distances.get(id)+1);queue.push(r.to.id);}
    }
    assert.deepEqual(expandEvents(f,q).nodes.map(n=>n.id).sort(),[...distances.keys()].sort());
  }
});

test('schema3不自动升级；显式升级保留旧来源',t=>{
  const path=disk(t),s=setup(t,{path,attention:false}),original=s.store.read(s.o.id);s.store.close();
  const DB=sqlite.Database??sqlite.DatabaseSync,raw=new DB(path);raw.exec('PRAGMA user_version=3');raw.close();
  assert.throws(()=>new ContinuityStore(path),code('MIGRATION_REQUIRED'));
  const check=new DB(path);assert.equal(check.prepare('PRAGMA user_version').get().user_version,3);check.close();
  const upgraded=new ContinuityStore(path,{migrateV3:true});assert.deepEqual(upgraded.read(original.id),original);assert.equal(upgraded.snapshot().schemaVersion,SCHEMA_VERSION);
  new ContinuitySession({store:upgraded,subjectId:'person',attention:true});assert.equal(upgraded.read(attentionId('person')).residences.length,0);upgraded.close();
});

test('任务完成后释放该 process 的材料驻留',t=>{
  const s=setup(t);
  commit(s,{attention:patch({processes:[process('p')],residency:{upsert:[residence('r','p','process',[purpose('active-task'),purpose('self-directed')])],remove:[]}})});
  assert.equal(snapshot(s).residences.length,1);
  next(s);
  commit(s,{attention:patch({processes:[process('p',{expectedRevision:1,status:'completed'})]})});
  assert.equal(snapshot(s).residences.length,0);
});