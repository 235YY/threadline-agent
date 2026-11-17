import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {canonical} from '../src/contracts.mjs';
import {prepareDecision,commitDecision,prepareReview,stageReview,adoptReview,readCognitionRecord,ablateDecisionPacket} from '../src/cognition.mjs';
import {memory,event,note,frame,put,ref,disk} from './helpers.mjs';

function setup(t,store=memory(t).store) {
  const [past,current,feeling,belief,goal,w]=put(store,'setup',
    event('past',{scene:'mc',body:'之前放箱子时朝向没有对齐'}),event('current',{scene:'mc',body:'接着修我们的家吧'}),
    note('feeling',[{id:'past',revision:1}],{kind:'feeling',body:'刚才有点烦躁，但不是对哥哥生气'}),
    note('belief',[{id:'past',revision:1}],{kind:'skill',body:'放箱子前先看看朝向'}),
    note('goal',[],{kind:'dream',body:'想把我们的家造完'}),frame({scene:'mc',focus:{id:'villa',label:'一起修家'}}));
  const materials=[{ref:ref(past),aspect:'experience'},{ref:ref(feeling.record),aspect:'feeling'},
    {ref:ref(belief.record),aspect:'belief'},{ref:ref(goal.record),aspect:'goal'}];
  const args={store,currentEvent:ref(current),workspace:ref(w),materials,allowedActionTools:['mc.inspect'],budgetBytes:24000};
  return {store,past,current,feeling:feeling.record,belief:belief.record,goal:goal.record,w,materials,args};
}
function decisionOutput(packet,kind='act') {
  return {packetId:packet.packetId,options:[{id:'chosen',kind,payload:kind==='act'?{tool:'mc.inspect',args:{target:'chest'}}:kind==='respond'?{text:'行呀，先看看箱子'}:{reason:'fixture-intent'}}],
    selected:'chosen',summary:'合成决定：结合旧经验先检查，不证明真实模型受到了影响',
    used:packet.payload.materials.filter(m=>['feeling','belief','goal'].some(a=>m.aspects.includes(a))).map(m=>({ref:m.ref,aspect:m.aspects[0],effect:'context'}))};
}
function commit(s,kind='act',id='decision') {
  const packet=prepareDecision(s.args),output=decisionOutput(packet,kind);
  const d=commitDecision({store:s.store,packet,output,requestId:`commit:${id}`,decisionId:id,allowedActionTools:['mc.inspect']});
  return {packet,output,d};
}
function receipt(s,id='decision',status='failed',eventId='result') {
  return put(s.store,`receipt:${eventId}`,{op:'record_receipt',actionId:`${id}:action`,expectedRevision:1,status,eventId,
    body:'合成执行器回报：目标前方有阻挡，尚未完成放置',actor:'fixture-executor',source:{system:'fixture-executor',key:eventId}})[0];
}
function proposal(s,packet,fields={}) {
  return {id:'belief',expectedRevision:1,body:'先检查朝向与碰撞，再决定是否放置',kind:'skill',change:'new_evidence',confidence:'tentative',status:'current',
    scope:{scenes:[],people:[],validFrom:null,validUntil:null},evidence:[ref(s.past),ref(packet.payload.feedback[0])],...fields};
}
function reviewOutput(s,packet,disposition='update',updates) {
  return {packetId:packet.packetId,disposition,summary:'合成整理：失败提供了信息，是否学会还待后续表现',
    updates:updates??(disposition==='update'?[proposal(s,packet)]:[]),questions:[]};
}
function reviewSetup(t) {
  const s=setup(t),c=commit(s);receipt(s);
  const packet=prepareReview({store:s.store,decision:ref(c.d),materials:s.materials,budgetBytes:24000});
  return {...s,c,reviewPacket:packet};
}

test('决策前实际交付经历、感受、认识、目标；多用途同正文去重且保留出处',t=>{
  const s=setup(t), p=prepareDecision({...s.args,materials:[...s.materials,{ref:ref(s.belief),aspect:'knowledge'}]});
  assert.deepEqual(p.payload.materials.find(m=>m.ref.id==='belief').aspects,['belief','knowledge']);
  assert.equal(p.payload.materials.length,4);assert.ok(p.payload.materials.some(m=>m.record.kind==='feeling'));
  assert.equal(p.payload.materials.find(m=>m.ref.id==='past').record.scene,'mc');
  assert.equal(p.bytes,Buffer.byteLength(canonical(p.messages),'utf8'));
  assert.throws(()=>prepareDecision({...s.args,budgetBytes:500}),{code:'INPUT_OVERFLOW'});
});

test('个人材料含背景或想象时仍保留性质；它们不能冒充当前真实触发',t=>{
  const s=setup(t);const [b]=put(s.store,'background',event('background',{origin:'background',body:'编写的童年素材'}));
  const p=prepareDecision({...s.args,materials:[{ref:ref(b),aspect:'experience'}]});
  assert.equal(p.payload.materials[0].record.origin,'background');
  assert.throws(()=>prepareDecision({...s.args,currentEvent:ref(b)}),{code:'NOT_AN_ENCOUNTER'});
});

test('身份由宿主明确提供且纳入预算，不从工具提示词另造人格',t=>{
  const s=setup(t),identity='鲸漾，小名鲸鲸，十四岁；用户是哥哥';
  const p=prepareDecision({...s.args,identity});
  assert.equal(p.payload.identity,identity);assert.equal(prepareDecision(s.args).payload.identity,'');
  assert.throws(()=>prepareDecision({...s.args,identity:'字'.repeat(4001)}),{code:'INPUT_LIMIT'});
});

test('决定与动作意图原子提交；引用不自动加深记忆，动作尚未完成',t=>{
  const s=setup(t),{d}=commit(s);
  assert.equal(d.type,'decision');assert.equal(s.store.read(d.action.id).status,'proposed');
  assert.equal(s.store.read(d.action.id).receipt,null);
  assert.equal(s.store.uses('belief').length,0);assert.equal(s.store.uses('feeling').length,0);
  assert.equal(d.output.used.length,3);
});

test('未交付引用、伪造用途与重复使用声明被拒绝',t=>{
  const s=setup(t),packet=prepareDecision(s.args),output=decisionOutput(packet);
  output.used[0].ref={id:'not-delivered',revision:1};
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'bad',decisionId:'bad',allowedActionTools:['mc.inspect']}),{code:'UNDELIVERED_REFERENCE'});
  output.used=[{ref:ref(s.goal),aspect:'feeling',effect:'context'}];
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'bad2',decisionId:'bad2',allowedActionTools:['mc.inspect']}),{code:'UNDELIVERED_REFERENCE'});
  output.used=[{ref:ref(s.goal),aspect:'goal',effect:'support'},{ref:ref(s.goal),aspect:'goal',effect:'support'}];
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'bad3',decisionId:'bad3',allowedActionTools:['mc.inspect']}),{code:'DUPLICATE_USE'});
});

test('输出不能注入回执、存储命令或权限；动作授权在提交时重查',t=>{
  const s=setup(t),packet=prepareDecision(s.args),output=decisionOutput(packet);
  assert.throws(()=>commitDecision({store:s.store,packet,output:{...output,receipt:'succeeded'},requestId:'forge',decisionId:'forge',allowedActionTools:['mc.inspect']}),{code:'OUTPUT_SHAPE'});
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'revoked',decisionId:'revoked',allowedActionTools:[]}),{code:'TOOL_NOT_GRANTED'});
  output.options[0].payload.tool='shell.delete';
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'forbidden',decisionId:'forbidden',allowedActionTools:['shell.delete']}),{code:'TOOL_NOT_GRANTED'});
  assert.equal(s.store.read('forbidden:action'),null);
});

test('lookup提出明确词项或固定版本引用，不能用模糊的任意字段伪装已查询',t=>{
  const s=setup(t),packet=prepareDecision(s.args),output=decisionOutput(packet,'lookup');
  output.used=[];output.options[0].payload={模糊:'帮我查一下'};
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'bad-lookup',decisionId:'bad-lookup'}),{code:'OUTPUT_SHAPE'});
  output.options[0].payload={terms:['箱子','朝向']};
  assert.equal(commitDecision({store:s.store,packet,output,requestId:'lookup-terms',decisionId:'lookup-terms'}).action,null);
  output.options[0].payload={ref:ref(s.past)};
  assert.equal(commitDecision({store:s.store,packet,output,requestId:'lookup-ref',decisionId:'lookup-ref'}).output.options[0].kind,'lookup');
});

test('输入篡改、错误packetId和过大的输出被拒绝',t=>{
  const s=setup(t),packet=prepareDecision(s.args),output=decisionOutput(packet);
  const damaged=structuredClone(packet);damaged.payload.materials[0].record.body='篡改';
  assert.throws(()=>commitDecision({store:s.store,packet:damaged,output,requestId:'a',decisionId:'a'}),{code:'PACKET_CHANGED'});
  assert.throws(()=>commitDecision({store:s.store,packet,output:{...output,packetId:'wrong'},requestId:'b',decisionId:'b'}),{code:'WRONG_PACKET'});
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'c',decisionId:'c',maxOutputBytes:20}),{code:'OUTPUT_OVERFLOW'});
});

test('过期工作处境不能提交决定，行动意图也不能残留',t=>{
  const s=setup(t),packet=prepareDecision(s.args),output=decisionOutput(packet);
  put(s.store,'switch',frame({expectedRevision:1,focus:{id:'new',label:'新活动'}}));
  assert.throws(()=>commitDecision({store:s.store,packet,output,requestId:'stale',decisionId:'stale',allowedActionTools:['mc.inspect']}),{code:'STALE_WORKSPACE'});
  assert.equal(s.store.read('stale:action'),null);assert.equal(s.store.read('stale'),null);
});

test('当前个人材料变化也使旧判断失效；允许明确读旧版本作历史',t=>{
  const s=setup(t),p=prepareDecision(s.args),output=decisionOutput(p);
  put(s.store,'change',note('belief',[ref(s.past)],{expectedRevision:1,body:'新的理解',change:'reinterpretation'}));
  assert.throws(()=>commitDecision({store:s.store,packet:p,output,requestId:'old',decisionId:'old',allowedActionTools:['mc.inspect']}),{code:'STALE_MATERIAL'});
  assert.equal(s.store.read('old:action'),null);
  const historic=prepareDecision(s.args);assert.equal(historic.payload.materials.find(m=>m.ref.id==='belief').historical,true);
  assert.doesNotThrow(()=>commitDecision({store:s.store,packet:historic,output:decisionOutput(historic,'wait'),requestId:'history',decisionId:'history'}));
});

test('等待与内外表达不同合法，不强制所有材料都参与',t=>{
  const s=setup(t),p=prepareDecision(s.args),o=decisionOutput(p,'respond');o.options[0].payload.text='没事，先放着吧';o.used=[];
  const d=commitDecision({store:s.store,packet:p,output:o,requestId:'speak',decisionId:'speak'});
  assert.equal(d.action,null);assert.equal(s.store.read('feeling').body,'刚才有点烦躁，但不是对哥哥生气');
  const w=commit(s,'wait','wait');assert.equal(w.d.action,null);assert.equal(w.d.output.options[0].kind,'wait');
});

test('日志不进入普通个人记忆检索，但她可显式查自己的运行记录',t=>{
  const s=setup(t),{d}=commit(s);
  assert.equal(s.store.search({terms:['合成决定']}).total,0);
  assert.equal(readCognitionRecord({store:s.store,ref:ref(d)}).id,d.id);
});

test('没有实际回执不能整理成动作结果；真实失败可进入整理',t=>{
  const s=setup(t),{d}=commit(s);
  assert.throws(()=>prepareReview({store:s.store,decision:ref(d),materials:s.materials,budgetBytes:24000}),{code:'REVIEW_NOT_READY'});
  receipt(s);
  const p=prepareReview({store:s.store,decision:ref(d),materials:s.materials,budgetBytes:24000});
  assert.equal(p.payload.action.status,'failed');assert.equal(p.payload.feedback[0].origin,'tool_receipt');
});

test('非行动反馈明确没有执行回执，想象不能充作真实反馈',t=>{
  const s=setup(t),{d}=commit(s,'wait');
  const p=prepareReview({store:s.store,decision:ref(d),feedbackRefs:[ref(s.current)],budgetBytes:24000});
  assert.equal(p.payload.executionStatus,'no-execution-receipt');
  const [fake]=put(s.store,'fake',event('fake',{origin:'imagination'}));
  assert.throws(()=>prepareReview({store:s.store,decision:ref(d),feedbackRefs:[ref(fake)],budgetBytes:24000}),{code:'NOT_AN_ENCOUNTER'});
});

test('整理提案先暂存，采用后新认识进入下一次决策输入，旧版仍保留',t=>{
  const s=reviewSetup(t),output=reviewOutput(s,s.reviewPacket);
  const r=stageReview({store:s.store,packet:s.reviewPacket,output,requestId:'stage',reviewId:'review'});
  assert.equal(r.status,'proposed');assert.equal(s.store.read('belief').revision,1);
  const adopted=adoptReview({store:s.store,review:ref(r),requestId:'adopt'});
  assert.equal(adopted.status,'adopted');assert.equal(s.store.read('belief').revision,2);
  assert.equal(s.store.read('belief',1).body,'放箱子前先看看朝向');
  const next=prepareDecision({...s.args,materials:[{ref:{id:'belief',revision:2},aspect:'belief'},{ref:ref(s.feeling),aspect:'feeling'},{ref:ref(s.goal),aspect:'goal'}]});
  assert.equal(next.payload.materials.find(m=>m.ref.id==='belief').record.body,output.updates[0].body);
  assert.equal(s.store.uses('belief').length,0);
});

test('不更新、悬置和请求信息会保存，但不强制改记忆',t=>{
  const s=reviewSetup(t);
  for(const disposition of ['keep','defer','lookup']){
    const r=stageReview({store:s.store,packet:s.reviewPacket,output:reviewOutput(s,s.reviewPacket,disposition),requestId:disposition,reviewId:disposition});
    assert.notEqual(r.status,'proposed');
    assert.throws(()=>adoptReview({store:s.store,review:ref(r),requestId:`adopt:${disposition}`}),{code:'REVIEW_NOT_PENDING'});
  }
  assert.equal(s.store.read('belief').revision,1);
});

test('未读修改目标、未交付证据与自证均不能成为整理提案',t=>{
  const s=reviewSetup(t),p=s.reviewPacket;
  const bads=[{id:'unread',expectedRevision:1},{evidence:[{id:'not-delivered',revision:1}]},{evidence:[ref(s.belief)]}];
  const codes=['UNREAD_TARGET','UNDELIVERED_REFERENCE','SELF_SUPPORT'];
  for(let i=0;i<bads.length;i++)assert.throws(()=>stageReview({store:s.store,packet:p,output:reviewOutput(s,p,'update',[proposal(s,p,bads[i])]),requestId:`bad${i}`,reviewId:`bad${i}`}),{code:codes[i]});
});

test('一项提案采用失败时，之前的笔记写入及review状态全部回滚',t=>{
  const s=reviewSetup(t),p=s.reviewPacket;
  const first=proposal(s,p,{id:'first-new',expectedRevision:0}),bad=proposal(s,p,{id:'second-new',expectedRevision:0,evidence:[]});
  const r=stageReview({store:s.store,packet:p,output:reviewOutput(s,p,'update',[first,bad]),requestId:'stage',reviewId:'review'});
  assert.throws(()=>adoptReview({store:s.store,review:ref(r),requestId:'fail-adopt'}),{code:'NO_NEW_SOURCE'});
  assert.equal(s.store.read('first-new'),null);assert.equal(s.store.read('second-new'),null);assert.equal(s.store.read('review').status,'proposed');
});

test('整理等待期间认识变化，旧提案不覆盖新认识',t=>{
  const s=reviewSetup(t),p=s.reviewPacket;
  const r=stageReview({store:s.store,packet:p,output:reviewOutput(s,p),requestId:'stage',reviewId:'review'});
  put(s.store,'other-view',note('belief',[ref(s.past)],{expectedRevision:1,change:'reinterpretation',body:'另一个有效的新理解'}));
  assert.throws(()=>adoptReview({store:s.store,review:ref(r),requestId:'adopt'}),{code:'STALE_MATERIAL'});
  assert.equal(s.store.read('belief').body,'另一个有效的新理解');assert.equal(s.store.read('review').status,'proposed');
});

test('决定、暂存与采用的完全重试持久去重，换内容复用请求会拒绝',t=>{
  const s=reviewSetup(t),original=s.c;
  const again=commitDecision({store:s.store,packet:original.packet,output:original.output,requestId:'commit:decision',decisionId:'decision',allowedActionTools:['mc.inspect']});
  assert.equal(again.id,'decision');
  const output=reviewOutput(s,s.reviewPacket);
  const r=stageReview({store:s.store,packet:s.reviewPacket,output,requestId:'stage',reviewId:'review'});
  const a=adoptReview({store:s.store,review:ref(r),requestId:'adopt'});
  assert.deepEqual(adoptReview({store:s.store,review:ref(r),requestId:'adopt'}),a);
  assert.equal(s.store.read('belief').revision,2);
  assert.throws(()=>stageReview({store:s.store,packet:s.reviewPacket,output:{...output,summary:'改内容'},requestId:'stage',reviewId:'review'}),{code:'REQUEST_COLLISION'});
});

test('成对消融只改个人材料通道，不偷换当前场景；共有用途注明残留',t=>{
  const s=setup(t),p=prepareDecision({...s.args,materials:[...s.materials,{ref:ref(s.feeling),aspect:'belief'}]});
  const removed=ablateDecisionPacket(p,'goal');
  assert.deepEqual(removed.packet.payload.current,p.payload.current);assert.deepEqual(removed.packet.payload.workspace,p.payload.workspace);
  assert.ok(!removed.packet.payload.materials.some(m=>m.ref.id==='goal'));assert.equal(p.payload.materials.length,4);
  const shared=ablateDecisionPacket(p,'feeling');assert.equal(shared.intervention.retainedShared[0].id,'feeling');
  assert.deepEqual(shared.packet.payload.materials.find(m=>m.ref.id==='feeling').aspects,['belief']);
});

test('决定、整理采用和新旧认识的完整闭环重启后仍保留',t=>{
  const path=disk(t);let store=new ContinuityStore(path,{clock:()=>2000});
  const s=setup(t,store),{d}=commit(s);receipt(s);
  const packet=prepareReview({store,decision:ref(d),materials:s.materials,budgetBytes:24000});
  const r=stageReview({store,packet,output:reviewOutput(s,packet),requestId:'stage',reviewId:'review'});
  adoptReview({store,review:ref(r),requestId:'adopt'});store.close();
  store=new ContinuityStore(path,{clock:()=>2000});
  assert.equal(store.read(d.id).type,'decision');assert.equal(store.read('review').status,'adopted');
  assert.equal(store.read('belief').revision,2);assert.equal(store.read('belief',1).body,'放箱子前先看看朝向');
  assert.equal(store.snapshot().schemaVersion,SCHEMA_VERSION);store.close();
});

test('旧新工程schema 1只允许显式升级，完整保留原记录',t=>{
  const path=disk(t),store=new ContinuityStore(path,{clock:()=>2000});setup(t,store);store.close();
  const DB=sqlite.Database??sqlite.DatabaseSync,db=new DB(path);db.exec('PRAGMA user_version=1');db.close();
  assert.throws(()=>new ContinuityStore(path),{code:'MIGRATION_REQUIRED'});
  const unchanged=new DB(path);assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version,1);unchanged.close();
  const migrated=new ContinuityStore(path,{migrateV1:true});
  assert.equal(migrated.read('belief').body,'放箱子前先看看朝向');assert.equal(migrated.read('past').body,'之前放箱子时朝向没有对齐');
  assert.equal(migrated.snapshot().schemaVersion,SCHEMA_VERSION);migrated.close();
});
