import test from 'node:test';
import assert from 'node:assert/strict';
import {memory,event,frame,note,put,ref} from './helpers.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {normalizeLookupQuery} from '../src/local-query.mjs';
function setup(t){
 const {store}=memory(t),session=new ContinuitySession({store,subjectId:'person'}),policy={maxHits:2,maxReads:8};
 const [current,anchor,old,w]=put(store,'init',event('current'),event('new-batch'),event('old-batch'),frame());
 for(let i=0;i<6;i++)put(store,'old:'+i,event('a-old-'+i,{body:'连接旧经验',occurredAt:5000+i}));
 function action(id,context,body){
  put(store,'a:'+id,{op:'propose_action',id,workspace:ref(w),tool:'fixture',args:{},inputRefs:[ref(context)]});
  put(store,'r:'+id,{op:'record_receipt',actionId:id,expectedRevision:1,status:'succeeded',eventId:'r:'+id,body,source:{system:'fixture',key:'r:'+id},actor:'executor'});
  return store.read('r:'+id);
 }
 const oldReceipt=action('old',old,'连接旧批次B成功'),newReceipt=action('new',anchor,'当前实际A成功：关键词可以不相同');
 put(store,'knowledge',note('z-note',[ref(newReceipt)],{body:'连接：当前这次A通过，其他批次未知'}));
 const lookup=new LocalLookupSession({store,subjectId:'person',policy});let index=0;
 const query=q=>{
  const packet=session.prepare({currentEvent:ref(current),workspace:ref(w),localLookupPolicy:policy,budgetBytes:48000});
  const id='d'+(++index),d=session.commit({packet,decisionId:id,requestId:id,output:{packetId:packet.packetId,options:[{id:'q',kind:'lookup',payload:q}],selected:'q',summary:'人工结构测试',used:[],
   continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled'}}});
  return lookup.execute({decision:ref(d)});
 };
 return {store,session,current,anchor,old,w,query,oldReceipt,newReceipt,policy};
}
test('当前显式动作回执及笔记排前；不靠时间或ID，且不要求关键词碰巧一致',t=>{
 const s=setup(t),r=s.query({context:{anchor:ref(s.anchor),terms:['连接']}});
 assert.equal(r.method,'explicit-context-then-substring');assert.equal(r.total,9);
 assert.deepEqual(r.entries.map(x=>x.ref.id).sort(),['r:new','z-note']);
 assert.ok(r.entries.every(x=>x.contextMatch==='explicit-action-or-evidence-lineage'));
 assert.equal(s.store.read(s.newReceipt.id).revision,1);
});
test('旧经历仍可翻页或直接读取，不因当前关联丧失访问权',t=>{
 const s=setup(t),first=s.query({context:{anchor:ref(s.anchor),terms:['连接']}}),second=s.query({pageAfter:ref(first)});
 assert.ok(second.entries.some(x=>x.ref.id.startsWith('a-old')));assert.deepEqual(second.query.context.anchor,ref(s.anchor));
 const exact=s.query({ref:ref(s.oldReceipt)});assert.equal(exact.entries[0].ref.id,s.oldReceipt.id);
});
test('未提供context时精确词项旧基线不变，关联不被自动猜出',t=>{
 const s=setup(t),r=s.query({terms:['连接']});assert.equal(r.entries[0].ref.id,'a-old-0');assert.equal(r.method,'exact-substring');
 assert.ok(r.entries.every(x=>!Object.hasOwn(x,'contextMatch')));
});
test('分页期间源变化则停止，不将不同快照页面拼接',t=>{
 const s=setup(t),first=s.query({context:{anchor:ref(s.anchor),terms:['连接']}});
 put(s.store,'late',event('late',{body:'连接新变化'}));
 const next=s.query({pageAfter:ref(first)});assert.equal(next.outcome,'source-changed');
});
test('不存在的归属与不合法查询被拒绝，不制造一个批次',t=>{
 const s=setup(t);assert.throws(()=>s.query({context:{anchor:{id:'imagined-batch',revision:1},terms:['连接']}}));
 assert.throws(()=>normalizeLookupQuery({context:{anchor:ref(s.anchor),terms:[],guessed:true}}));
});
