import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ContinuityStore} from '../src/store.mjs';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {canonical} from '../src/contracts.mjs';
import {prepareDecision,commitDecision,prepareReview,verifiedModelInput} from '../src/cognition.mjs';
import {initializeSubject,admitSubjectEvent,continuityInput,readPersonalState,readReaction,claimResponse,recordResponseDelivery,recoverResponse} from '../src/continuity.mjs';
import {memory,disk,event,frame,put,ref,note} from './helpers.mjs';
import * as reference from '../experiments/continuity-reference/state.mjs';

const DB=sqlite.Database??sqlite.DatabaseSync;
function setup(t,{store=memory(t).store,maxForeground=8}={}){
  initializeSubject({store,subjectId:'jingyang',requestId:'subject-init',maxForeground});
  const [o,w]=put(store,'start',event('o1'),frame());
  admitSubjectEvent({store,subjectId:'jingyang',event:ref(o),requestId:'admit-o1'});
  return {store,o,w};
}
function input(s,extra={}) {return prepareDecision({store:s.store,subjectId:'jingyang',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000,...extra});}
const change=(id='mood',body='有点失落，但原因还没想清楚',extra={})=>({id,expectedRevision:0,kind:'feeling',body,nature:'self-report',reason:'人工合成状态，不是实际模型心理测量',basis:null,...extra});
function output(p,{changes=[],kind='respond',payload={text:'我先做点自己的事'},residency={add:[],remove:[]},expressionChoice=null,disposition='handled'}={}){
  return {packetId:p.packetId,options:[{id:'a',kind,payload}],selected:'a',summary:'人工给定选择，用于验证实际持久化接线',used:[],
    continuity:{changes,residency,expressionChoice,observationDisposition:disposition}};
}
function commit(s,id='d1',options={},extra={}) {const packet=input(s,extra),out=output(packet,options);
  const decision=commitDecision({store:s.store,packet,output:out,requestId:`commit-${id}`,decisionId:id,allowedActionTools:extra.allowedActionTools??[]});return {packet,out,decision};}
function next(s,id='o2',fields={}) {const [o]=put(s.store,`append-${id}`,event(id,fields));admitSubjectEvent({store:s.store,subjectId:'jingyang',event:ref(o),requestId:`admit-${id}`});return {...s,o};}

test('状态、决定、回复意图及观察处理真实写入同一个SQLite事务',t=>{
  const s=setup(t),c=commit(s,'d1',{changes:[change()]});
  assert.equal(c.decision.type,'decision');assert.equal(s.store.read('mood').type,'personal_state');
  assert.equal(s.store.read('jingyang').lastDecision.id,'d1');assert.equal(s.store.read('d1:response').status,'pending');
  assert.equal(s.store.subjectObservation('jingyang','o1').status,'handled');assert.equal(s.store.read('d1:attempt').status,'adopted');
  assert.deepEqual(s.store.integrity(),{database:'ok',foreignKeyViolations:0,missingHeads:0});
});

test('下一轮自动交付前台正文，不需要再提供materials或语义检索',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});const p=input(next(s));
  assert.equal(p.stage,'decisionContinuity');assert.equal(p.payload.materials.length,0);
  assert.equal(p.payload.continuity.foreground[0].body,'有点失落，但原因还没想清楚');
  assert.equal(p.payload.continuity.foreground[0].basisStatus,'unspecified');
  assert.deepEqual(verifiedModelInput(p).messages,p.messages);
});

test('重新理解不要求新来源；未改字段和历史版本保留',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change(),change('plan','补完屋顶再看消息',{kind:'intention'})]});
  const oldPlan=canonical(s.store.read('plan'));commit(next(s),'d2',{changes:[change('mood','可能只是他在忙，不急着猜原因',{expectedRevision:1,nature:'reappraisal',basis:{priorStates:[ref(s.store.read('mood'))]}})]});
  assert.equal(s.store.read('mood').revision,2);assert.equal(s.store.read('mood',1).body,'有点失落，但原因还没想清楚');
  assert.equal(canonical(s.store.read('plan')),oldPlan);assert.deepEqual(s.store.read('mood').basis.observations,[]);
});

test('keep不改状态版本，也不因本轮曝光自动加深记忆',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});const old=canonical(s.store.read('mood'));commit(next(s),'d2');
  assert.equal(canonical(s.store.read('mood')),old);assert.deepEqual(s.store.uses('mood'),[]);
});

test('退到后台和重新进前台不重述、不删除、不创建内容版本',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});const before=canonical(s.store.read('mood'));
  commit(next(s),'park',{residency:{add:[],remove:['mood']}});assert.equal(input(next(s,'o3')).payload.continuity.foreground.length,0);
  const p=input(next(s,'o4'),{stateRefs:[ref(s.store.read('mood'))]});assert.equal(p.payload.continuity.recalled[0].body,s.store.read('mood').body);
  commit(next(s,'o5'),'restore',{residency:{add:['mood'],remove:[]}});assert.equal(canonical(s.store.read('mood')),before);
});

test('同一主体跨QQ与MC继续携带状态，作用域不阻断显式访问',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change('mc-mood','刚才挖矿有点烦',{scope:['mc']})]});
  const [w]=put(s.store,'mc-workspace',frame({id:'mc',scene:'mc:world',focus:{id:'villa',label:'补屋顶'}}));
  const p=input(next({...s,w},'mc-o',{scene:'mc:world'}));assert.equal(p.payload.continuity.foreground[0].body,'刚才挖矿有点烦');
  assert.equal(readPersonalState({store:s.store,subjectId:'jingyang',state:ref(s.store.read('mc-mood'))}).record.scope[0],'mc');
});

test('内心、掩饰意图与实际发送状态分开，失败不会改掉内心',t=>{
  const s=setup(t),c=commit(s,'d1',{changes:[change()],payload:{text:'我没事呀'},expressionChoice:{mode:'mask',reason:'这次不展开聊'}});
  let reaction=readReaction({store:s.store,subjectId:'jingyang',decision:ref(c.decision)});assert.equal(reaction.expressionChoice.mode,'mask');assert.equal(reaction.response.status,'pending');
  const claimed=claimResponse({store:s.store,response:ref(s.store.read('d1:response')),claimId:'send1',worker:'fixture-sender',requestId:'claim'});
  recordResponseDelivery({store:s.store,response:ref(claimed),claimId:'send1',outcome:'failed',eventId:'failed-send',body:'合成发送器失败回执',source:{system:'fixture-sender',key:'failed-send'},actor:'fixture',requestId:'delivery'});
  reaction=readReaction({store:s.store,subjectId:'jingyang',decision:ref(c.decision)});assert.equal(reaction.response.status,'failed');assert.match(s.store.read('mood').body,/失落/);
  assert.equal(s.store.subjectObservation('jingyang','failed-send').status,'handled');
});

test('没有表达选择时保持null，不从文字猜测动机',t=>{
  const s=setup(t),c=commit(s);assert.equal(readReaction({store:s.store,subjectId:'jingyang',decision:ref(c.decision)}).expressionChoice,null);
});

test('准备输入不消费消息；deferred保留可审计状态',t=>{
  const s=setup(t);input(s);assert.equal(s.store.subjectObservation('jingyang','o1').status,'received');
  commit(s,'wait',{kind:'wait',payload:{},disposition:'deferred'});assert.equal(s.store.subjectObservation('jingyang','o1').status,'deferred');
  assert.equal(s.store.subjectInbox({subjectId:'jingyang'}).total,1);
  assert.equal(s.store.subjectInbox({subjectId:'jingyang',excludeDeferred:true}).total,0);
  assert.equal(s.store.read('wait:response'),null);
});

test('未入箱和非真实触发不能悄悄创建个人状态',t=>{
  const s=setup(t),[o]=put(s.store,'unadmitted',event('other'));assert.throws(()=>input({...s,o}),{code:'OBSERVATION_NOT_ADMITTED'});
  const [b]=put(s.store,'background',event('background',{origin:'background'}));
  assert.throws(()=>admitSubjectEvent({store:s.store,subjectId:'jingyang',event:ref(b),requestId:'bad-admit'}),{code:'NOT_AN_ENCOUNTER'});
});

test('状态依据必须在本次输入，不因数据库里存在就能偷用',t=>{
  const s=setup(t),[hidden]=put(s.store,'hidden',event('hidden'));
  assert.throws(()=>commit(s,'bad',{changes:[change('mood','结论',{nature:'encounter',basis:{observations:[ref(hidden)]}})]}),{code:'UNDELIVERED_BASIS'});
  assert.equal(s.store.read('mood'),null);assert.equal(s.store.read('bad'),null);assert.equal(s.store.read('bad:attempt').status,'captured');
});

test('状态可基于已交付长期认识重新解释，不能伪造新的外部证据',t=>{
  const s=setup(t),[n]=put(s.store,'belief',note('belief',[],{body:'有时没有回复只是对方在忙'}));
  commit(s,'d1',{changes:[change('mood','先不急着下结论',{nature:'reappraisal',basis:{memories:[ref(n.record)]}})]},{materials:[{ref:ref(n.record),aspect:'belief'}]});
  assert.deepEqual(s.store.read('mood').basis.memories,[ref(n.record)]);assert.deepEqual(s.store.read('mood').basis.observations,[]);
});

test('一样的结论加了不同依据，仍保存该依据变化',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});
  const nextS=next(s);commit(nextS,'d2',{changes:[change('mood',s.store.read('mood').body,{expectedRevision:1,nature:'encounter',basis:{observations:[ref(nextS.o)]}})]});
  assert.equal(s.store.read('mood').revision,2);assert.equal(s.store.read('mood').basis.observations[0].id,'o2');
});

test('容量失败整体回滚，但原始提案独立留存，不丢模型已经提出的变化',t=>{
  const s=setup(t,{maxForeground:1});commit(s,'d1',{changes:[change()]});const oldSubject=canonical(s.store.read('jingyang'));
  const nextS=next(s);assert.throws(()=>commit(nextS,'overflow',{changes:[change('plan','补屋顶',{kind:'intention'})]}),{code:'FOREGROUND_CAPACITY'});
  assert.equal(s.store.read('plan'),null);assert.equal(s.store.read('overflow'),null);assert.equal(s.store.read('overflow:response'),null);
  assert.equal(canonical(s.store.read('jingyang')),oldSubject);assert.equal(s.store.subjectObservation('jingyang','o2').status,'received');
  assert.equal(s.store.read('overflow:attempt').output.continuity.changes[0].body,'补屋顶');
  commit(nextS,'corrected',{changes:[change('plan','补屋顶',{kind:'intention'})],residency:{add:[],remove:['mood']}});assert.deepEqual(s.store.read('jingyang').foreground,[{id:'plan',revision:1}]);
});

test('中途SQL错误也不能留下状态或可发送回复，只有未采用提案',t=>{
  let store;t.after(()=>store?.close());const path=disk(t);store=new ContinuityStore(path,{clock:()=>2000});const s=setup(t,{store});
  const db=new DB(path);db.exec("CREATE TRIGGER fixture_abort_subject BEFORE UPDATE ON objects WHEN old.type='subject' BEGIN SELECT RAISE(ABORT,'fixture abort after state write'); END;");db.close();
  assert.throws(()=>commit(s,'aborted',{changes:[change()]}),/fixture abort/);
  assert.equal(store.read('mood'),null);assert.equal(store.read('aborted'),null);assert.equal(store.read('aborted:response'),null);
  assert.equal(store.read('aborted:attempt').status,'captured');assert.equal(store.subjectObservation('jingyang','o1').status,'received');assert.equal(store.integrity().database,'ok');
});

test('旧模型输出不能覆盖新全局状态；失败提案仍可审阅',t=>{
  const s=setup(t),old=input(s);commit(s,'new',{changes:[change()]});
  assert.throws(()=>commitDecision({store:s.store,packet:old,output:output(old,{changes:[change('older')]}),requestId:'old',decisionId:'older'}),{code:'STALE_SUBJECT'});
  assert.equal(s.store.read('older'),null);assert.equal(s.store.read('older:response'),null);assert.equal(s.store.read('older:attempt').status,'captured');
});

test('同一请求重试不会双写或把后来的状态倒回去',t=>{
  const s=setup(t),c=commit(s,'d1',{changes:[change()]});commit(next(s),'d2',{changes:[change('mood','后来平静一些',{expectedRevision:1,nature:'reappraisal'})]});
  const before=canonical(s.store.read('jingyang'));
  const again=commitDecision({store:s.store,packet:c.packet,output:c.out,requestId:'commit-d1',decisionId:'d1'});
  assert.equal(again.id,'d1');assert.equal(canonical(s.store.read('jingyang')),before);assert.equal(s.store.read('mood').revision,2);
  assert.equal(s.store.list({type:'response'}).items.length,2);
});

test('不读后台当前版就不能改；读历史版也不能覆盖当前版',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});commit(next(s),'park',{residency:{add:[],remove:['mood']}});
  assert.throws(()=>commit(next(s,'o3'),'unread',{changes:[change('mood','改了',{expectedRevision:1})]}),{code:'UNREAD_STATE'});
  commit(next(s,'o4'),'read',{changes:[change('mood','改了',{expectedRevision:1})]},{stateRefs:[ref(s.store.read('mood'))]});
  assert.throws(()=>commit(next(s,'o5'),'historical',{changes:[change('mood','回退',{expectedRevision:1})]},{stateRefs:[{id:'mood',revision:1}]}),{code:'STATE_CONFLICT'});
});

test('默认卡片与按需详细模式都计入完整模型消息预算',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});const n=next(s),simple=input(n),detail=input(n,{stateDetail:true});
  assert.equal('predecessor' in simple.payload.continuity.foreground[0],false);assert.equal(detail.payload.continuity.foreground[0].record.type,'personal_state');
  assert.ok(detail.bytes>simple.bytes);assert.throws(()=>input(n,{budgetBytes:simple.bytes-1}),{code:'INPUT_OVERFLOW'});
  assert.equal(s.store.read('mood').revision,1);
});

test('状态不混入普通事实搜索，提案和运行协议也不变成人设',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change('mood','状态独有词Z499')]});
  assert.equal(s.store.search({terms:['状态独有词Z499']}).total,0);assert.equal(continuityInput({store:s.store,subjectId:'jingyang'}).foreground[0].body,'状态独有词Z499');
  assert.equal(s.store.list({type:'decision_attempt'}).items.length,1);
});

test('后台review缺反馈仍可暂不能跑，但不会阻止即时状态先保存',t=>{
  const s=setup(t),c=commit(s,'d1',{changes:[change()]});
  assert.throws(()=>prepareReview({store:s.store,decision:ref(c.decision),budgetBytes:24000}),{code:'FEEDBACK_REQUIRED'});
  assert.equal(input(next(s)).payload.continuity.foreground[0].ref.id,'mood');
});

test('重启后读取真实SQLite检查点，旧版、反应、待发回复都还在',t=>{
  let store;t.after(()=>store?.close());const path=disk(t);store=new ContinuityStore(path,{clock:()=>2000});const s=setup(t,{store});commit(s,'d1',{changes:[change()]});store.close();
  store=new ContinuityStore(path,{clock:()=>3000});const n=next({...s,store});
  assert.equal(input(n).payload.continuity.foreground[0].body,'有点失落，但原因还没想清楚');
  assert.equal(store.read('d1:response').status,'pending');assert.equal(store.read('mood',1).body,'有点失落，但原因还没想清楚');
  assert.equal(store.subjectInbox({subjectId:'jingyang'}).items[0].eventId,'o2');
});

test('回复领取后中断不会被自动重发，unknown可以后续核实且旧回执保留',t=>{
  let store;t.after(()=>store?.close());const path=disk(t);store=new ContinuityStore(path,{clock:()=>2000});const s=setup(t,{store});commit(s);const claimed=claimResponse({store,response:ref(store.read('d1:response')),claimId:'send-1',worker:'fixture',requestId:'claim'});store.close();
  store=new ContinuityStore(path,{clock:()=>3000});
  assert.throws(()=>claimResponse({store,response:ref(store.read('d1:response')),claimId:'send-2',worker:'fixture',requestId:'claim2'}),{code:'RESPONSE_NOT_PENDING'});
  const unknown=recoverResponse({store,response:ref(claimed),claimId:'send-1',eventId:'uncertain',body:'进程中断，发送结果未知',source:{system:'fixture',key:'uncertain'},actor:'fixture',requestId:'recover'});
  assert.equal(unknown.status,'unknown');
  const sent=recordResponseDelivery({store,response:ref(unknown),claimId:'send-1',outcome:'sent',eventId:'confirmed',body:'模拟查询到发送器已接受',source:{system:'fixture',key:'confirmed'},actor:'fixture',requestId:'confirm'});
  assert.equal(sent.status,'sent');assert.equal(sent.receipts.length,2);assert.equal(store.read('uncertain').body,'进程中断，发送结果未知');
});

test('未经领取不能伪造发送回执；错误领取标识也不能确认',t=>{
  const s=setup(t);commit(s);const args={store:s.store,response:ref(s.store.read('d1:response')),claimId:'fake',outcome:'sent',eventId:'bad-send',body:'假的',source:{system:'fixture',key:'bad-send'},actor:'fixture',requestId:'bad-send'};
  assert.throws(()=>recordResponseDelivery(args),{code:'RESPONSE_NOT_CLAIMED'});assert.equal(s.store.read('bad-send'),null);
});

test('主体身份固定：重初始化不能清空状态或扩容，其他主体状态不能混入',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()]});initializeSubject({store:s.store,subjectId:'other',requestId:'other'});
  assert.throws(()=>initializeSubject({store:s.store,subjectId:'jingyang',requestId:'reset',maxForeground:32}),{code:'SUBJECT_EXISTS'});
  assert.throws(()=>continuityInput({store:s.store,subjectId:'other',stateRefs:[ref(s.store.read('mood'))]}),{code:'MISSING_STATE'});
  assert.deepEqual(s.store.read('jingyang').foreground,[{id:'mood',revision:1}]);
});

test('schema2默认不升级；显式升级保留全部旧对象和历史',t=>{
  let upgraded;t.after(()=>upgraded?.close());const path=disk(t),store=new ContinuityStore(path);const [o]=put(store,'old',event('old'));store.close();
  let db=new DB(path);db.exec('DROP TABLE subject_inbox; PRAGMA user_version=2');db.close();
  assert.throws(()=>new ContinuityStore(path),{code:'MIGRATION_REQUIRED'});db=new DB(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);db.close();
  upgraded=new ContinuityStore(path,{migrateV2:true});assert.deepEqual(upgraded.read('old',1),o);assert.equal(upgraded.snapshot().schemaVersion,SCHEMA_VERSION);
});

test('子进程提交后立即异常退出：重开仍有状态、决定和待发回复',t=>{
  let store;t.after(()=>store?.close());const path=disk(t),worker=fileURLToPath(new URL('./fixtures/continuity-crash-worker.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[worker,path],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,29,result.stderr);store=new ContinuityStore(path);
  assert.equal(store.read('crash-state').body,'已经提交，等待下轮继续');assert.equal(store.read('crash-decision:response').status,'pending');
  assert.equal(store.read('jingyang').lastDecision.id,'crash-decision');assert.equal(store.integrity().database,'ok');
});

test('完整调用入口把第一轮保存的状态交给第二轮调用，使用合成客户端',async t=>{
  const s=setup(t),session=new ContinuitySession({store:s.store,subjectId:'jingyang'});let calls=0;
  const invoke=async ({messages})=>{calls++;const payload=JSON.parse(messages[1].content);
    if(calls===2)assert.equal(payload.continuity.foreground[0].body,'有点失落，但原因还没想清楚');
    return output({packetId:payload.packetId},{changes:calls===1?[change()]:[]});};
  const first=await session.run({invoke,requestId:'run1',decisionId:'run1',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000});
  const n=next(s);await session.run({invoke,requestId:'run2',decisionId:'run2',currentEvent:ref(n.o),workspace:ref(n.w),budgetBytes:48000});
  assert.equal(calls,2);assert.equal(first.decision.id,'run1');assert.equal(s.store.read('mood').revision,1);
});

test('已提交轮次重启式重入不会再次调用客户端，换内容复用ID会拒绝',async t=>{
  const s=setup(t),session=new ContinuitySession({store:s.store,subjectId:'jingyang'});let calls=0;
  const args={invoke:async ({messages})=>{calls++;return output({packetId:JSON.parse(messages[1].content).packetId});},requestId:'run1',decisionId:'run1',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000};
  await session.run(args);const again=await session.run(args);assert.equal(again.modelCalled,false);assert.equal(calls,1);
  await assert.rejects(()=>session.run({...args,identity:'另一次不同身份输入'}),{code:'DECISION_ID_COLLISION'});
});

test('客户端失败不会处理来信或伪造回复，入口不自动重试',async t=>{
  const s=setup(t),session=new ContinuitySession({store:s.store,subjectId:'jingyang'});let calls=0;
  await assert.rejects(()=>session.run({invoke:async ()=>{calls++;throw Error('fixture provider failed');},requestId:'r1',decisionId:'r1',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000}),/fixture provider failed/);
  assert.equal(calls,1);assert.equal(s.store.subjectObservation('jingyang','o1').status,'received');assert.equal(s.store.read('r1'),null);assert.equal(s.store.read('r1:response'),null);
});

test('已有未采用提案时重入只返回提案，不为容量错误再次花一次模型调用',async t=>{
  const s=setup(t,{maxForeground:1}),session=new ContinuitySession({store:s.store,subjectId:'jingyang',maxForeground:1});let calls=0;
  const args={invoke:async ({messages})=>{calls++;return output({packetId:JSON.parse(messages[1].content).packetId},{changes:[change('one'),change('two')]});},requestId:'overflow',decisionId:'overflow',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000};
  await assert.rejects(()=>session.run(args),{code:'FOREGROUND_CAPACITY'});const resumed=await session.run(args);
  assert.equal(resumed.status,'pending-proposal');assert.equal(resumed.modelCalled,false);assert.equal(calls,1);assert.equal(s.store.read('one'),null);
});

test('默认下轮能区分上次说话意图与尚未发送，不把掩饰句当内心',t=>{
  const s=setup(t);commit(s,'d1',{changes:[change()],expressionChoice:{mode:'mask',reason:null},payload:{text:'我没事'}});
  const p=input(next(s));assert.equal(p.payload.continuity.lastReaction.utterance,'我没事');assert.equal(p.payload.continuity.lastReaction.responseStatus,'pending');
  assert.match(p.payload.continuity.foreground[0].body,/失落/);assert.equal(p.payload.continuity.lastReaction.fromScene,'qq:brother');
});

test('收件箱分页不丢尾页，重复入箱不重复观察也不重置已处理状态',t=>{
  const s=setup(t);commit(s);admitSubjectEvent({store:s.store,subjectId:'jingyang',event:ref(s.o),requestId:'readmit'});
  assert.equal(s.store.subjectObservation('jingyang','o1').status,'handled');for(let i=0;i<5;i++)next(s,`pending-${i}`);
  const page1=s.store.subjectInbox({subjectId:'jingyang',limit:3}),page2=s.store.subjectInbox({subjectId:'jingyang',limit:3,afterSeq:page1.next});
  assert.equal(page1.total,5);assert.equal(page1.items.length,3);assert.equal(page2.items.length,2);assert.equal(page2.next,null);
  assert.equal(new Set([...page1.items,...page2.items].map(x=>x.eventId)).size,5);
});

test('过去检查点绑定当时的状态版本，不会随最新头指针改变',t=>{
  const s=setup(t),first=commit(s,'d1',{changes:[change()]});
  commit(next(s),'d2',{changes:[change('mood','已经改变了想法',{expectedRevision:1,nature:'reappraisal'})]});
  const old=readReaction({store:s.store,subjectId:'jingyang',decision:ref(first.decision)});
  assert.deepEqual(old.stateAfter.foreground,[{id:'mood',revision:1}]);assert.equal(s.store.read('jingyang').foreground[0].revision,2);
  assert.equal(s.store.read(old.stateAfter.foreground[0].id,old.stateAfter.foreground[0].revision).body,'有点失落，但原因还没想清楚');
});

test('同一个会话内并发重入同轮共享在途调用，不重复调用客户端',async t=>{
  const s=setup(t),session=new ContinuitySession({store:s.store,subjectId:'jingyang'});let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const args={invoke:async ({messages})=>{calls++;await gate;return output({packetId:JSON.parse(messages[1].content).packetId});},requestId:'same',decisionId:'same',currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:48000};
  const first=session.run(args),second=session.run(args);release();const results=await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(results[0].decision.id,results[1].decision.id);assert.equal(s.store.read('same').revision,1);
});

test('40轮实际SQLite状态转移与前阶段独立纯函数参考一致',t=>{
  const s=setup(t);let expected=reference.createState('jingyang'),seed=0x837ac1;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const known=new Set();
  for(let i=0;i<40;i++){
    const id=`differential-${random(5)}`,old=s.store.read(id),c=change(id,`合成局部状态${i}`,{expectedRevision:old?.revision??0,nature:old?'reappraisal':'self-report'});
    const residency=i%7===0?{add:[],remove:[id]}:i%11===0?{add:[id],remove:[]}:{add:[],remove:[]};
    const current=i===0?s:next(s,`diff-event-${i}`),extra=old?{stateRefs:[ref(old)]}:{};
    commit(current,`diff-${i}`,{changes:[c],residency},extra);known.add(id);
    const p=reference.prepare(expected,{focus:'合成差分对照',extraRefs:old?[ref(old)]:[],budgetBytes:48000});
    expected=reference.commit(expected,p,{id:`ref-${i}`,packetId:p.packetId,changes:[c],residency,decision:{kind:'wait',payload:{}}},{recordedAt:2000}).state;
    for(const key of known){const actual=s.store.read(key),want=reference.readState(expected,key);for(const field of ['body','revision','kind','status','scope'])assert.deepEqual(actual[field],want[field]);}
    assert.deepEqual(s.store.read('jingyang').foreground.map(r=>r.id),expected.foreground);
  }
});
