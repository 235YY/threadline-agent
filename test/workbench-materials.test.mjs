import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {MaintenanceSession} from '../src/maintenance.mjs';
import {attentionId,keepAttention} from '../src/attention.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {canonical} from '../src/contracts.mjs';
import {wirePacket,expandOutput} from '../experiments/automated-study/protocol.mjs';
import {disk,put,event,note,frame,ref,code} from './helpers.mjs';

const policy={maxReads:4,maxHits:4};
const purpose=(kind='self-directed',fields={})=>({kind,eventIds:[],questionId:null,appliesTo:null,...fields});
const use=(id,target,fields={})=>({id,target:{kind:'material',ref:target},cue:'尚需对照，入口不是事实结论',purposes:[purpose()],presentation:'full',...fields});
const process=(status='active',expectedRevision=0)=>({id:'compare',expectedRevision,label:'核对记录',body:'对照认识和原文，还未形成结论',status,world:'actual',intervals:[],basis:[]});
const taskUse=(id,target)=>use(id,target,{purposes:[purpose('active-task',{eventIds:['compare']})]});
const state=(id,body='还在意这件事')=>({id,expectedRevision:0,kind:'feeling',nature:'self-report',body,status:'open'});
function setup(t,{path=':memory:',body='旧记录：尚未开工，不能称作已修好',cBody='新一份补充资料：工具暂时缺失'}={}){
 const store=new ContinuityStore(path,{clock:()=>Date.UTC(2026,10,4,12)});t.after(()=>store.close());
 const session=new ContinuitySession({store,subjectId:'synthetic',attention:true});
 const [o,w,,b,c]=put(store,'seed',event('o'),frame(),note('a',[],{body:'我原来暂时以为已经修好，但还要核对'}),event('b',{body}),event('c',{body:cBody}));
 return {store,session,o,w,a:store.read('a'),b,c,n:0,path};
}
const snapshot=s=>s.store.read(attentionId('synthetic'));
const prepare=(s,args={})=>s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,workbenchMaterials:true,budgetBytes:131072,...args});
function output(p,{upsert=[],remove=[],processes=[],changes=[],kind='wait',payload={},used=[]}={}){
 return {packetId:p.packetId,options:[{id:'next',kind,payload}],selected:'next',summary:'本地预置决定，用于验证装配；不冒充模型自主意义判断',used,
  continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{...keepAttention(),processes,residency:{upsert,remove}}}};
}
function commit(s,options={},p=prepare(s)){
 const id=`d${++s.n}`;return s.session.commit({packet:p,output:output(p,options),decisionId:id,requestId:`commit:${id}`});
}
function next(s,body='换一条当前消息'){
 [s.o]=put(s.store,`observation:${++s.n}`,event(`o${s.n}`,{body}));return s;
}
function fetch(s,target,{upsert=[],processes=[]}={}){
 const d=commit(s,{upsert,processes,kind:'lookup',payload:{ref:ref(target)}});
 return new LocalLookupSession({store:s.store,subjectId:'synthetic',policy}).execute({decision:ref(d)});
}
const ids=p=>p.payload.materials.map(m=>m.ref.id).sort();
const assignment=x=>({ref:ref(x),aspect:x.type==='event'?'experience':'belief'});

test('保留A并读取B：必要旧材料与新正文共同交付，不需要第二套缓存或模型审批轮',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a)]});
 const d=commit(s,{upsert:[taskUse('a-use',ref(s.a))],processes:[process()],kind:'lookup',payload:{ref:ref(s.b)}},p);
 const result=new LocalLookupSession({store:s.store,subjectId:'synthetic',policy}).execute({decision:ref(d)});
 const q=prepare(s,{lookupResults:[ref(result)]});assert.deepEqual(ids(q),['a','b']);
 assert.equal(q.payload.continuity.attention.materialSupport.enabled,true);
 assert.equal(q.payload.materials.find(m=>m.ref.id==='b').record.body,s.b.body);
 assert.deepEqual(s.store.uses('a'),[]);assert.equal(s.store.read('a').revision,1);
});

test('需要A/B后再查C，仍交付三者；仅最新/最近两份的简单基线会丢前项',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a),assignment(s.b)]});
 commit(s,{processes:[process()],upsert:[taskUse('a-use',ref(s.a)),taskUse('b-use',ref(s.b))]},p);
 const result=fetch(s,s.c),q=prepare(s,{lookupResults:[ref(result)]});
 assert.deepEqual(ids(q),['a','b','c']);
 const d=commit(s,{used:q.payload.materials.map(m=>({ref:m.ref,aspect:m.aspects[0],effect:'context'}))},q);
 assert.equal(d.output.used.length,3);assert.deepEqual(s.store.uses('a'),[]);
});

test('同一材料多用途只交付一次，退出一个驻留不撤另一项用途',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a)]});
 commit(s,{upsert:[use('one',ref(s.a)),use('two',ref(s.a))]},p);
 assert.deepEqual(ids(prepare(next(s))),['a']);
 commit(s,{remove:['one']});assert.deepEqual(ids(prepare(next(s))),['a']);
 assert.deepEqual(snapshot(s).residences.map(r=>r.id),['two']);
});

test('显式收为入口后正文退出，新消息仍有恢复点，恢复直接固定读取',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a),assignment(s.b)]});
 commit(s,{upsert:[use('ua',ref(s.a)),use('ub',ref(s.b))]},p);
 commit(next(s),{upsert:[use('ua',ref(s.a),{presentation:'entry'}),use('ub',ref(s.b),{presentation:'entry'})]});
 const q=prepare(next(s,'哥来聊晚饭了'));assert.deepEqual(ids(q),[]);
 assert.equal(q.payload.continuity.attention.materials.length,2);
 assert.ok(q.payload.continuity.attention.residences.every(r=>r.cue.includes('尚需对照')));
 commit(s,{upsert:[use('ua',ref(s.a)),use('ub',ref(s.b))]},q);
 const restored=prepare(next(s,'继续刚才核对'));assert.deepEqual(ids(restored),['a','b']);
 assert.equal(restored.payload.materials[1].record.body,s.b.body);
});

test('过程暂停只收材料入口，恢复自动展开，结束退出用途但不删除记忆',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a),assignment(s.b)]});
 commit(s,{processes:[process()],upsert:[taskUse('ua',ref(s.a)),taskUse('ub',ref(s.b))]},p);
 commit(next(s),{processes:[process('paused',1)]});assert.deepEqual(ids(prepare(next(s))),[]);assert.equal(snapshot(s).residences.length,2);
 commit(s,{processes:[process('active',2)]});assert.deepEqual(ids(prepare(next(s))),['a','b']);
 commit(s,{processes:[process('completed',3)]});assert.equal(snapshot(s).residences.length,0);
 assert.equal(s.store.read('a').revision,1);assert.equal(s.store.read('b').body,s.b.body);
});

test('同一补丁可暂停过程并把材料收入口，不要求再来一轮填写',t=>{
 const s=setup(t);commit(s,{processes:[process()],upsert:[taskUse('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));
 commit(next(s),{processes:[process('paused',1)],upsert:[{...taskUse('u',ref(s.a)),presentation:'entry'}]});
 assert.deepEqual(ids(prepare(next(s))),[]);assert.equal(snapshot(s).residences[0].presentation,'entry');
});

test('等待回答的材料随问题暂挂/恢复/取消变化，不因自己发言当作回答',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a)]});
 const q={id:'question',expectedRevision:0,op:'open',text:'先核对哪部分？',awaitingResponseFrom:'brother',responseEvent:null};
 const id=`d${++s.n}`,out=output(p,{upsert:[use('u',ref(s.a),{purposes:[purpose('awaiting-reply',{questionId:q.id})]})],kind:'respond',payload:{text:q.text}});
 out.continuity.attention.questions=[q];s.session.commit({packet:p,output:out,decisionId:id,requestId:`commit:${id}`});
 assert.deepEqual(ids(prepare(next(s))),['a']);assert.equal(snapshot(s).questions[0].status,'open');
 for(const [op,expectedRevision,want] of [['suspend',1,[]],['resume',2,['a']],['cancel',3,[]]]){
  const p=prepare(s),out=output(p);out.continuity.attention.questions=[{...q,op,expectedRevision}];
  const id=`d${++s.n}`;s.session.commit({packet:p,output:out,decisionId:id,requestId:`commit:${id}`});
  assert.deepEqual(ids(prepare(next(s))),want);
 }
 assert.equal(snapshot(s).residences.length,0);
});

test('三种装配政策使用同一真实本地读取序列：用途驻留比最近两份保留多一个仍必需的A',t=>{
 const observed={};
 for(const strategy of ['latest','recent-two','purpose']){
  const s=setup(t),reader=new LocalLookupSession({store:s.store,subjectId:'synthetic',policy});
  const a=fetch(s,s.a),pa=prepare(s,{lookupResults:[ref(a)]});
  const db=commit(s,{kind:'lookup',payload:{ref:ref(s.b)},...(strategy==='purpose'?{upsert:[use('ua',ref(s.a))]}:{})},pa);
  const b=reader.execute({decision:ref(db)}),pb=prepare(s,{lookupResults:[ref(b),...(strategy==='recent-two'?[ref(a)]:[])]});
  const dc=commit(s,{kind:'lookup',payload:{ref:ref(s.c)},...(strategy==='purpose'?{upsert:[use('ub',ref(s.b))]}:{})},pb);
  const c=reader.execute({decision:ref(dc)}),pc=prepare(s,{lookupResults:[ref(c),...(strategy==='recent-two'?[ref(b)]:[])]});observed[strategy]=ids(pc);
 }
 assert.deepEqual(observed,{latest:['c'],'recent-two':['b','c'],purpose:['a','b','c']});
});

test('针对本轮的影响绑定遇新消息只收入口，不自动销毁，也不强作新消息的依据',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a)]});
 const u=use('u',ref(s.a),{purposes:[purpose('affects-current-choice',{appliesTo:ref(s.o)})]});commit(s,{upsert:[u]},p);
 assert.deepEqual(ids(prepare(s)),['a']);const q=prepare(next(s));assert.deepEqual(ids(q),[]);
 assert.equal(q.payload.continuity.attention.materials[0].delivery,'entry');assert.equal(snapshot(s).residences.length,1);
});

test('固定旧版不自动换成新版；入口提示新版，旧版正文完整带条件',t=>{
 const s=setup(t);commit(s,{upsert:[use('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));
 put(s.store,'revise',note('a',[],{expectedRevision:1,body:'重评：原判断仍待核实',change:'reinterpretation'}));
 const p=prepare(next(s)),m=p.payload.materials[0];assert.equal(m.ref.revision,1);assert.equal(m.record.body,s.a.body);assert.equal(m.historical,true);
 assert.equal(m.currentHead.ref.revision,2);assert.equal(p.payload.continuity.attention.materials[0].currentHead.revision,2);
 commit(s);assert.equal(snapshot(s).residences[0].target.ref.revision,1);
});

test('目录或猜测的未读引用不能变成材料驻留，错误补丁整体拒绝',t=>{
 const s=setup(t),p=prepare(s);
 assert.throws(()=>commit(s,{upsert:[use('u',ref(s.a))],changes:[state('not-written')]},p),code('UNREAD_MATERIAL'));
 assert.equal(s.store.read('not-written'),null);assert.equal(snapshot(s).residences.length,0);
});

test('材料能力明确开启：不授权不能新增；已有绑定不能关闭能力偷偷漏交付',t=>{
 const s=setup(t),off=prepare(s,{workbenchMaterials:false,materials:[assignment(s.a)]});
 assert.throws(()=>commit(s,{upsert:[use('u',ref(s.a))]},off),code('WORKBENCH_CAPABILITY'));
 commit(s,{upsert:[use('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));
 assert.throws(()=>prepare(next(s),{workbenchMaterials:false}),code('WORKBENCH_CAPABILITY'));
});

test('必要正文超限拒绝整包装配；用途、版本和感受不被静默淘汰',t=>{
 const s=setup(t,{body:'完整否定和条件。'.repeat(800)});
 commit(s,{upsert:[use('ua',ref(s.a)),use('ub',ref(s.b))],changes:[state('feeling')]},prepare(s,{materials:[assignment(s.a),assignment(s.b)]}));
 next(s);const full=prepare(s),before=canonical(snapshot(s));
 assert.throws(()=>prepare(s,{budgetBytes:full.bytes-1}),e=>e.code==='WORKBENCH_REQUIRED_OVERFLOW'&&e.details.requiredMaterials.length===2);
 assert.equal(canonical(snapshot(s)),before);assert.equal(s.store.read('feeling').body,'还在意这件事');
 assert.deepEqual(ids(prepare(s)),['a','b']);
});

test('预算先保必要A/B，可选C放不下会记录遗漏，不把一半对照挤走',t=>{
 const s=setup(t,{cBody:'无关补充，内容较长。'.repeat(600)});
 commit(s,{upsert:[use('ua',ref(s.a)),use('ub',ref(s.b))]},prepare(s,{materials:[assignment(s.a),assignment(s.b)]}));
 const result=fetch(s,s.c),full=prepare(s,{lookupResults:[ref(result)]});assert.deepEqual(ids(full),['a','b','c']);
 const small=prepare(s,{lookupResults:[ref(result)],budgetBytes:full.bytes-4000});assert.deepEqual(ids(small),['a','b']);
 assert.ok(small.payload.information.presentation.omitted.some(x=>x.ref.id==='c'));
 assert.equal(snapshot(s).residences.length,2);
});

test('薄接口只在显式能力开启时说明材料驻留，直接映射到同一核心补丁',t=>{
 const s=setup(t),p=prepare(s,{materials:[assignment(s.a)]}),wire=wirePacket(p,'compact');
 assert.ok(wire.instruction.includes('本轮启用工作台材料用途驻留'));
 const raw=JSON.stringify({packetId:wire.packetId,choice:{kind:'wait',payload:{}},attention:{...keepAttention(),residency:{upsert:[use('u',ref(s.a))],remove:[]}}});
 s.session.commit({packet:p,output:expandOutput(wire,raw),decisionId:'compact-hold',requestId:'compact-hold'});
 assert.deepEqual(ids(prepare(next(s))),['a']);
});

test('退出原文与形成当前认识在同一事务；失败不会只退出或只保存一半',t=>{
 const s=setup(t);commit(s,{upsert:[use('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));
 const p=prepare(next(s));assert.throws(()=>commit(s,{remove:['u','missing'],changes:[state('broken')]},p),code('RESIDENCE_MISSING'));
 assert.equal(s.store.read('broken'),null);assert.equal(snapshot(s).residences.length,1);
 commit(s,{remove:['u'],changes:[state('retained','核对后暂不下定论，仍在意') ]},p);
 assert.deepEqual(ids(prepare(next(s))),[]);assert.equal(s.store.read('retained').body,'核对后暂不下定论，仍在意');assert.equal(s.store.read('a').revision,1);
});

test('看完可直接退出，不必强迫写一条新认识；曝光不强化',t=>{
 const s=setup(t);commit(s,{upsert:[use('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));
 const before=[...s.store.all('personal_state')].length;commit(next(s),{remove:['u']});
 assert.equal([...s.store.all('personal_state')].length,before);assert.deepEqual(s.store.uses('a'),[]);assert.equal(s.store.read('a').revision,1);
});

test('后台维护把材料当来源，不冒充个人状态；过时前台补丁仍拒绝',t=>{
 const s=setup(t);commit(s,{upsert:[use('u',ref(s.a),{presentation:'entry'})]},prepare(s,{materials:[assignment(s.a)]}));
 const maintenance=new MaintenanceSession({store:s.store,subjectId:'synthetic'}),inspection=maintenance.inspect();
 assert.equal(inspection.status,'ready');const p=inspection.job.packet.payload;
 assert.ok(!p.continuity.recalled.some(c=>c.ref.id==='a'));assert.ok(p.sources.some(c=>c.ref.id==='a')||p.materials.some(c=>c.ref.id==='a'));
 const old=prepare(next(s));commit(s,{remove:['u']});
 assert.throws(()=>commit(s,{upsert:[use('u',ref(s.a))]},old),code('STALE_SUBJECT'));
});

test('跨重启保留材料用途，调试只读呈现输入模式与绑定',t=>{
 const path=disk(t),s=setup(t,{path});
 commit(s,{upsert:[use('u',ref(s.a))]},prepare(s,{materials:[assignment(s.a)]}));s.store.close();
 const store=new ContinuityStore(path),session=new ContinuitySession({store,subjectId:'synthetic',attention:true});try{
 const p=session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),workbenchMaterials:true,budgetBytes:131072});assert.deepEqual(ids(p),['a']);
 const d=commit({...s,store,session},{remove:['u']},p);
 const archive=new DebugArchive(path);try{
  const report=archive.inspect({packetId:p.packetId});assert.equal(report.input.workbenchMaterials.enabled,true);
  assert.equal(report.input.workbenchMaterials.bindings[0].target.ref.id,'a');assert.equal(report.input.workbenchMaterials.bindings[0].cue,undefined);
  assert.equal(report.input.workbenchMaterials.projection[0].delivery,'required');
  const changed=archive.inspect({decisionId:d.id});assert.equal(changed.materialResidency.before.length,1);assert.equal(changed.materialResidency.after.length,0);
  assert.deepEqual(changed.materialResidency.removed,['u']);
 }finally{archive.close();}
 }finally{store.close();}
});

test('旧schema8默认拒绝写入升级；显式副本迁移保留全部原版本',t=>{
 const path=disk(t),s=setup(t,{path});const original=canonical(s.store.read('a'));s.store.close();
 const DB=sqlite.Database??sqlite.DatabaseSync,db=new DB(path);db.exec('PRAGMA user_version=8');db.close();
 assert.throws(()=>new ContinuityStore(path),code('MIGRATION_REQUIRED'));
 const check=new DB(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,8);check.close();
 const upgraded=new ContinuityStore(path,{migrateV8:true});try{assert.equal(canonical(upgraded.read('a')),original);assert.equal(SCHEMA_VERSION,11);}finally{upgraded.close();}
});

const cleanupProc=(id,status='active',expectedRevision=0)=>({...process(status,expectedRevision),id});
const prepareCleanup=(s,args={})=>prepare(s,{workbenchFocus:true,...args});
function commitCleanup(s,options={},p=prepareCleanup(s)) { const out=output(p,options);if(options.processes?.some(v=>v.id==='B'&&v.expectedRevision===0))out.continuity.attention.focus={select:[{kind:'process',id:'B',path:[]}]};const id='cleanup-d'+(++s.n);return s.session.commit({packet:p,output:out,decisionId:id,requestId:id});}
const releaseDone=s=>s.store.execute({requestId:'release:'+ (++s.n),commands:[{op:'release_completed_workbench',subjectId:'synthetic'}]});
for(const remaining of ['active','paused'])test('shared cleanup keeps one purpose owned by A(done) and B('+remaining+')',t=>{
 const s=setup(t);commitCleanup(s,{processes:[cleanupProc('A'),cleanupProc('B',remaining)],upsert:[use('shared',ref(s.a),{purposes:[purpose('active-task',{eventIds:['A','B']})]})]},prepareCleanup(s,{materials:[assignment(s.a)]}));
 commitCleanup(next(s),{processes:[cleanupProc('A','completed',1)]});assert.equal(snapshot(s).residences.length,1);releaseDone(s);
 assert.equal(snapshot(s).residences.length,1,'host cleanup must keep the surviving purpose');
 if(remaining==='paused')commitCleanup(next(s),{processes:[cleanupProc('B','active',1)]});
 const q=prepareCleanup(next(s));assert.equal(q.payload.materials.find(m=>m.ref.id==='a').record.body,s.a.body);
 const revision=snapshot(s).revision;releaseDone(s);assert.equal(snapshot(s).revision,revision);
 commitCleanup(next(s),{processes:[cleanupProc('B','completed',remaining==='paused'?2:1)]});releaseDone(s);assert.equal(snapshot(s).residences.length,0);assert.equal(s.store.read('a').revision,1);
});
test('shared cleanup retains independent recovery purpose after both processes end',t=>{
 const s=setup(t);commitCleanup(s,{processes:[cleanupProc('A'),cleanupProc('B')],upsert:[use('shared',ref(s.a),{purposes:[purpose('active-task',{eventIds:['A','B']}),purpose('recovery-point')]})]},prepareCleanup(s,{materials:[assignment(s.a)]}));
 commitCleanup(next(s),{processes:[cleanupProc('A','completed',1)]});releaseDone(s);assert.equal(snapshot(s).residences.length,1);assert.equal(prepareCleanup(next(s)).payload.materials[0].record.id,'a');
 commitCleanup(s,{processes:[cleanupProc('B','completed',1)]});releaseDone(s);assert.equal(snapshot(s).residences.length,1);assert.deepEqual(ids(prepareCleanup(next(s))),[]);assert.equal(s.store.read('a').revision,1);
});


test('shared cleanup without focus removes ended binding without undefined fields',t=>{
 const s=setup(t);
 commit(s,{processes:[cleanupProc('A')],upsert:[use('only-A',ref(s.a),{purposes:[purpose('active-task',{eventIds:['A']})]})]},prepare(s,{materials:[assignment(s.a)]}));
 commit(next(s),{processes:[cleanupProc('A','completed',1)]});
 releaseDone(s);assert.equal(snapshot(s).residences.length,0);assert.equal(s.store.read('a').revision,1);
});
