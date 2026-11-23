import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {attentionId,keepAttention} from '../src/attention.mjs';
import {recoveryPage,exitedUse} from '../src/workbench-recovery.mjs';
import {canonical} from '../src/contracts.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';
import {wirePacket,expandOutput} from '../experiments/automated-study/protocol.mjs';
import {disk,event,note,frame,put,ref} from './helpers.mjs';
const who='synthetic-recovery',policy={maxReads:8,maxHits:4},p=(kind='active-task',ids=['a'])=>({kind,eventIds:ids,questionId:null,appliesTo:null});
const task=(id,fields={})=>({id,expectedRevision:0,label:id,body:'未完成',status:'active',world:'actual',intervals:[],basis:[],...fields});
function setup(t,path=':memory:',body='旧图纸：燕尾卡扣，未验收'){
 const s={store:new ContinuityStore(path),seq:0,path};t.after(()=>s.store.close());
 s.session=new ContinuitySession({store:s.store,subjectId:who,attention:true});
 put(s.store,'initial',event('o'),frame(),note('m',[],{body}),note('n',[],{body:'共享资料'}));s.o=s.store.read('o');s.w=s.store.read('qq');
 s.reader=new LocalLookupSession({store:s.store,subjectId:who,policy});return s;
}
const snap=s=>s.store.read(attentionId(who));
const prep=(s,args={})=>s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,budgetBytes:131072,...args});
function out(packet,o={}){return {packetId:packet.packetId,options:[{id:'x',kind:o.kind??'continue',payload:o.payload??{}}],selected:'x',summary:'本地恢复夹具，不是模型自主选择',used:[],
 continuity:{changes:o.changes??[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{...keepAttention(),processes:o.processes??[],relations:o.relations??[],residency:{upsert:o.upsert??[],remove:o.remove??[],...(o.restore?{restore:o.restore}:{})},...(o.select?{focus:{select:o.select}}:{})}}};}
function commit(s,o={},packet=prep(s)){const id='recovery-d'+(++s.seq);return s.session.commit({packet,output:out(packet,o),requestId:id,decisionId:id});}
const use=(id='u',fields={})=>({id,target:{kind:'material',ref:{id:'m',revision:1}},cue:'小灯原图，留意左侧固定件',presentation:'full',purposes:[p()],...fields});
function seed(s,extra={}){commit(s,{processes:[task('a'),task('b')],upsert:[use(),use('shared',{target:{kind:'material',ref:{id:'n',revision:1}},purposes:[p('active-task',['b'])]})],select:[{kind:'process',id:'a',path:[]}],...extra},prep(s,{materials:[{ref:{id:'m',revision:1},aspect:'belief'},{ref:{id:'n',revision:1},aspect:'belief'}]}));}
function remove(s){const before=snap(s);commit(s,{remove:['u']});return {frame:ref(snap(s)),id:'u',before};}
function lookup(s,workbench){const packet=prep(s),d=commit(s,{kind:'lookup',payload:{workbench}},packet),r=s.reader.execute({decision:ref(d)});return {result:r,packet:prep(s,{lookupResults:[ref(r)]})};}
const readExit=(s,source)=>lookup(s,{via:'read',source:{frame:source.frame,id:source.id}});
const restore=(r,id='u',presentation='entry')=>({source:ref(r),id,presentation});
const ids=packet=>packet.payload.materials.map(m=>m.ref.id).sort();

test('remove后可分页列出、读回并局部恢复；原文/关切/共享用途不变',t=>{
 const s=setup(t);seed(s,{changes:[{id:'care',expectedRevision:0,kind:'feeling',body:'仍在意礼物',nature:'self-report'}]});
 const old=snap(s),source=remove(s),other=canonical(snap(s).residences.find(r=>r.id==='shared')),care=canonical(s.store.read('care'));
 const listed=lookup(s,{via:'list',frame:ref(snap(s)),task:'a',cursor:null});assert.equal(listed.result.workbench.items[0].source.id,'u');
 assert.deepEqual(ids(listed.packet),[]);assert.equal(listed.result.workbench.items[0].exitReason,null);
 const r=readExit(s,source);assert.deepEqual(ids(r.packet),['m']);assert.equal(r.result.workbench.binding.focusToken,old.residences.find(r=>r.id==='u').focusToken);
 commit(s,{restore:[restore(r.result)]},r.packet);const now=snap(s);
 assert.equal(now.residences.find(r=>r.id==='u').presentation,'entry');assert.notEqual(now.residences.find(r=>r.id==='u').focusToken,old.residences.find(r=>r.id==='u').focusToken);
 assert.equal(canonical(now.residences.find(r=>r.id==='shared')),other);assert.equal(canonical(s.store.read('care')),care);assert.equal(s.store.read('m').revision,1);
 assert.deepEqual(ids(prep(s)),[]);assert.deepEqual(s.store.uses('m'),[]);assert.deepEqual(s.store.uses('n'),[]);
});
test('full恢复走原投影；不会偷偷切焦点或回滚之后的认识',t=>{
 const s=setup(t);seed(s);const source=remove(s);let packet=prep(s);const key=packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='interaction').key;
 commit(s,{select:[key],changes:[{id:'new-thought',expectedRevision:0,kind:'appraisal',body:'现在想先聊聊',nature:'self-report'}]},packet);
 const focus=canonical(snap(s).focus),r=readExit(s,source);commit(s,{restore:[restore(r.result,'u','full')]},r.packet);
 assert.equal(canonical(snap(s).focus),focus);assert.deepEqual(ids(prep(s)),[]);assert.equal(s.store.read('new-thought').body,'现在想先聊聊');
 packet=prep(s);const f=packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='process'&&m.selection.id==='a').key;
 commit(s,{select:[f]},packet);assert.deepEqual(ids(prep(s)),['m']);
});
test('目录/猜测回执不能恢复；失败同事务新增状态回滚',t=>{
 const s=setup(t);seed(s);remove(s);const listing=lookup(s,{via:'list',frame:ref(snap(s)),task:null,cursor:null});const before=canonical(snap(s));
 assert.throws(()=>commit(s,{restore:[restore(listing.result)],changes:[{id:'must-not-exist',expectedRevision:0,kind:'feeling',body:'失败事务',nature:'self-report'}]},listing.packet),{code:'UNREAD_RECOVERY'});
 assert.equal(s.store.read('must-not-exist'),null);assert.equal(canonical(snap(s)),before);
 assert.throws(()=>commit(s,{restore:[{source:{id:'invented',revision:1},id:'u',presentation:'entry'}]},listing.packet),{code:'UNREAD_RECOVERY'});
});
test('活同名用途不覆盖；改用新ID恢复也不改变新绑定',t=>{
 const s=setup(t);seed(s);const source=remove(s),r=readExit(s,source);
 commit(s,{upsert:[use('u',{cue:'后来建立的新用途'})]},r.packet);
 const r2=readExit(s,source),before=canonical(snap(s));
 assert.throws(()=>commit(s,{restore:[restore(r2.result)]},r2.packet),{code:'RECOVERY_CONFLICT'});assert.equal(canonical(snap(s)),before);
 commit(s,{restore:[restore(r2.result,'different')]},r2.packet);assert.equal(snap(s).residences.find(r=>r.id==='u').cue,'后来建立的新用途');
});
test('任务结束后只读原文仍可；直接恢复旧任务用途拒绝，可明确建立新用途',t=>{
 const s=setup(t);seed(s);const source=remove(s);commit(s,{processes:[task('a',{expectedRevision:1,status:'completed'})]});
 const r=readExit(s,source);assert.deepEqual(ids(r.packet),['m']);assert.throws(()=>commit(s,{restore:[restore(r.result)]},r.packet),{code:'RECOVERY_NEEDS_REBIND'});
 commit(s,{upsert:[use('history',{presentation:'entry',purposes:[p('recovery-point',[])]})]},r.packet);assert.equal(snap(s).processes.find(p=>p.id==='a').status,'completed');
});
test('旧父路径变更不能自动改接；共享B继续保留',t=>{
 const s=setup(t),edge={id:'edge',expectedRevision:0,type:'task-part-of',from:{id:'a',revision:1},to:{id:'b',revision:1},status:'active',basis:[]};
 seed(s,{relations:[edge],upsert:[use('u',{focusUse:{consumer:{kind:'process',id:'a'},owners:[{kind:'process',id:'b'}],context:[{id:'edge',revision:1}]}})]});
 const source=remove(s);commit(s,{processes:[task('b',{expectedRevision:1,body:'路径端点已有修订'})]});
 const r=readExit(s,source),before=canonical(snap(s));assert.throws(()=>commit(s,{restore:[restore(r.result)]},r.packet),{code:'RECOVERY_NEEDS_REBIND'});assert.equal(canonical(snap(s)),before);
});
test('暂停任务只允许entry续接，不擅自resume',t=>{
 const s=setup(t);seed(s);const source=remove(s);commit(s,{processes:[task('a',{expectedRevision:1,status:'paused'})]});const r=readExit(s,source);
 assert.throws(()=>commit(s,{restore:[restore(r.result,'u','full')]},r.packet),{code:'RECOVERY_NEEDS_REBIND'});
 commit(s,{restore:[restore(r.result)]},r.packet);assert.equal(snap(s).processes.find(p=>p.id==='a').status,'paused');assert.deepEqual(ids(prep(s)),[]);
});
test('旧焦点按用途代际保持blocked，同名恢复不复活旧选择',t=>{
 const s=setup(t);seed(s);let packet=prep(s);const f=packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='residence'&&m.selection.id==='u').key;
 commit(s,{select:[f]},packet);const old=canonical(snap(s).focus),source=remove(s),r=readExit(s,source);
 commit(s,{restore:[restore(r.result,'u','full')]},r.packet);assert.equal(canonical(snap(s).focus),old);
 packet=prep(s);assert.equal(packet.payload.continuity.attention.focusSupport.blocked.length,1);assert.deepEqual(ids(packet),[]);
});
test('跨重启查回退出项，固定旧原文而非自动升级新头',t=>{
 const path=disk(t),s=setup(t,path);seed(s);const source=remove(s);s.store.close();
 s.store=new ContinuityStore(path);s.session=new ContinuitySession({store:s.store,subjectId:who,attention:true});s.reader=new LocalLookupSession({store:s.store,subjectId:who,policy});
 try{put(s.store,'new-note-version',note('m',[],{expectedRevision:1,body:'新图纸：已经换了固定件'}));
  const r=readExit(s,source);assert.equal(r.result.workbench.binding.target.ref.revision,1);assert.match(r.packet.payload.materials[0].record.body,/燕尾卡扣/);
  assert.equal(r.packet.payload.materials[0].historical,true);commit(s,{restore:[restore(r.result)]},r.packet);
  assert.equal(snap(s).residences.find(r=>r.id==='u').target.ref.revision,1);assert.equal(s.store.read('m').revision,2);assert.equal(s.store.integrity().database,'ok');}finally{s.store.close();}
});
test('未启用能力时不得查询或恢复；薄接口仅在启用时追加说明',t=>{
 const s=setup(t);seed(s);remove(s);let packet=prep(s,{workbenchRecovery:false});
 assert.throws(()=>commit(s,{kind:'lookup',payload:{workbench:{via:'list',frame:ref(snap(s)),task:null,cursor:null}}},packet),{code:'RECOVERY_CAPABILITY'});
 assert.throws(()=>commit(s,{restore:[{source:{id:'x',revision:1},id:'u',presentation:'entry'}]},packet),{code:'RECOVERY_CAPABILITY'});
 packet=prep(s);const wire=wirePacket(packet,'compact-focus');assert.match(wire.instruction,/本轮recoverySupport启用/);
 assert.doesNotThrow(()=>expandOutput(wire,JSON.stringify({packetId:wire.packetId,choice:{kind:'continue',payload:{}}})));
});
test('历史访问限定本主体，越界帧拒绝',t=>{
 const s=setup(t);seed(s);remove(s);new ContinuitySession({store:s.store,subjectId:'another',attention:true});
 assert.throws(()=>commit(s,{kind:'lookup',payload:{workbench:{via:'list',frame:ref(s.store.read(attentionId('another'))),task:null,cursor:null}}}),{code:'RECOVERY_SCOPE'});
});
test('恢复与同ID upsert/remove冲突，未交付的材料也不能靠历史目录绕过',t=>{
 const s=setup(t);seed(s);const source=remove(s),r=readExit(s,source);
 assert.throws(()=>commit(s,{restore:[restore(r.result)],upsert:[use()]},r.packet),{code:'RESIDENCY_CONFLICT'});
 const packet=prep(s);assert.throws(()=>commit(s,{restore:[restore(r.result)]},packet),{code:'UNREAD_RECOVERY'});
});
test('历史分页同帧多项不漏不重，64帧扫描截断保留可前进游标',()=>{
 const frames=[];for(let revision=1;revision<=140;revision++)frames.push({id:'f',type:'attention_frame',subject:'s',revision,recordedAt:revision,residences:revision===1?Array.from({length:7},(_,i)=>use('u'+i)):[]});
 const read=(id,rev)=>frames.find(f=>f.id===id&&f.revision===rev),snapshot=ref(frames.at(-1));let cursor=null,found=[],pages=0,limited=false;
 do{const q={via:'list',frame:snapshot,task:null,cursor},rows=frames.filter(f=>f.revision>1&&f.revision<=(cursor?.revision??snapshot.revision)).sort((a,b)=>b.revision-a.revision).slice(0,64);
  const result=recoveryPage({query:q,frames:rows,read,subject:'s',maxHits:2});found.push(...result.items.map(i=>i.source.id));limited ||=result.scanLimited;cursor=result.nextCursor;assert.ok(++pages<10);
 }while(cursor);
 assert.equal(limited,true);assert.deepEqual(found,['u0','u1','u2','u3','u4','u5','u6']);assert.equal(new Set(found).size,7);
 assert.equal(exitedUse({frame:{id:'f',revision:3},id:'u0'},{read,subject:'s'}),null);
});
test('调试显示来源/恢复提案/实际新增，默认不导出旧用途正文',t=>{
 const s=setup(t,disk(t));seed(s);const source=remove(s),r=readExit(s,source);commit(s,{restore:[restore(r.result)]},r.packet);
 const a=new DebugArchive(s.path);try{const b=a.bundle({includeContent:false});const turn=b.turns.find(t=>t.useRecovery?.proposed.length);
  assert.ok(turn);assert.equal(turn.useRecovery.reads[0].kind,'material-use-read');assert.equal(turn.useRecovery.reads[0].details,undefined);assert.ok(turn.materialResidency.added.includes('u'));
 }finally{a.close();s.store.close();}
});
test('依赖用途同名重建后，旧focusPins不能自动接到新代际',t=>{
 const s=setup(t);seed(s,{upsert:[use('owner'),use('u',{focusUse:{consumer:{kind:'process',id:'a'},owners:[{kind:'residence',id:'owner'}],context:null}})]});
 const source=remove(s);commit(s,{remove:['owner']});const packet=prep(s,{materials:[{ref:{id:'m',revision:1},aspect:'belief'}]});commit(s,{upsert:[use('owner')]},packet);
 const r=readExit(s,source),before=canonical(snap(s));assert.throws(()=>commit(s,{restore:[restore(r.result)]},r.packet),{code:'RECOVERY_NEEDS_REBIND'});assert.equal(canonical(snap(s)),before);
});
test('历史回执可到达但正文被预算省略时，恢复仍拒绝而非暗中读过',t=>{
 const s=setup(t,':memory:','大段旧图纸。'.repeat(1200));seed(s);const source=remove(s),r=readExit(s,source);
 const bound=r.packet.bytes-Buffer.byteLength(s.store.read('m').body,'utf8')+1000;
 const packet=prep(s,{lookupResults:[ref(r.result)],budgetBytes:bound});assert.deepEqual(ids(packet),[]);assert.equal(packet.payload.information.results[0].workbench.kind,'material-use-read');
 const before=canonical(snap(s));assert.throws(()=>commit(s,{restore:[restore(r.result)]},packet),{code:'UNREAD_MATERIAL'});assert.equal(canonical(snap(s)),before);
});
test('旧的只影响当次观察的用途不能套用到新观察',t=>{
 const s=setup(t);seed(s,{upsert:[use('u',{purposes:[{kind:'affects-current-choice',eventIds:[],questionId:null,appliesTo:ref(s.o)}]})]});
 const source=remove(s);put(s.store,'new-observation',event('o2'));s.o=s.store.read('o2');const r=readExit(s,source);
 assert.throws(()=>commit(s,{restore:[restore(r.result)]},r.packet),{code:'RECOVERY_NEEDS_REBIND'});
});
test('并行共享原文移除A用途后，B照常；查回恢复A不改B绑定',t=>{
 const s=setup(t);seed(s,{upsert:[use('u'),use('parallel',{purposes:[p('active-task',['b'])]})]});
 const before=canonical(snap(s).residences.find(r=>r.id==='parallel')),source=remove(s);let packet=prep(s);
 const b=packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='process'&&m.selection.id==='b').key;commit(s,{select:[b]},packet);
 assert.deepEqual(ids(prep(s)),['m']);const r=readExit(s,source);commit(s,{restore:[restore(r.result)]},r.packet);
 assert.equal(canonical(snap(s).residences.find(r=>r.id==='parallel')),before);assert.deepEqual(ids(prep(s)),['m']);
});
test('同次恢复并明确选新用途可展开；提交重放不重复恢复，旧并发包不能覆盖',t=>{
 const s=setup(t);seed(s);const source=remove(s);let packet=prep(s);
 commit(s,{select:[packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='interaction').key]},packet);
 const r=readExit(s,source),f=r.packet.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='process'&&m.selection.id==='a').key;
 const args={packet:r.packet,output:out(r.packet,{restore:[restore(r.result,'u','full')],select:[f]}),decisionId:'once-restore',requestId:'once-restore'};
 s.session.commit(args);assert.deepEqual(ids(prep(s)),['m']);const after=canonical(snap(s));s.session.commit(args);assert.equal(canonical(snap(s)),after);
 assert.throws(()=>commit(s,{restore:[restore(r.result)]},r.packet),{code:'STALE_SUBJECT'});assert.equal(canonical(snap(s)),after);
});
test('同名用途多次退出是不同历史项，不因ID相同合并或复活',t=>{
 const s=setup(t);seed(s);const first=remove(s),r=readExit(s,first);commit(s,{restore:[restore(r.result)]},r.packet);const second=remove(s);
 const listed=lookup(s,{via:'list',frame:ref(snap(s)),task:'a',cursor:null});const rows=listed.result.workbench.items;
 assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.source.frame.revision),[second.frame.revision,first.frame.revision]);
 assert.equal(rows[0].source.id,rows[1].source.id);
});
test('有限穷举：两用途五帧、不同过滤和页宽，6144条分页链与直接差集一致',()=>{
 let checks=0;for(let pattern=0;pattern<1024;pattern++){
  const frames=Array.from({length:5},(_,i)=>({id:'f',type:'attention_frame',subject:'s',revision:i+1,recordedAt:i+1,
   residences:[use('a',{purposes:[p('active-task',['a'])]}),use('b',{purposes:[p('active-task',['b'])]})].filter((_,j)=>pattern&(1<<(i*2+j)))}));
  const read=(id,revision)=>frames.find(f=>f.id===id&&f.revision===revision),snapshot=ref(frames.at(-1));
  for(const task of [null,'a','b'])for(const width of [1,2]){
   const expected=frames.slice(1).reverse().flatMap(f=>frames[f.revision-2].residences.filter(r=>!f.residences.some(x=>x.id===r.id)&&(task===null||r.id===task)).map(r=>`${f.revision}:${r.id}`));
   let cursor=null,actual=[],steps=0;do{const query={via:'list',frame:snapshot,task,cursor},result=recoveryPage({query,frames:frames.filter(f=>f.revision>1&&f.revision<=(cursor?.revision??5)).reverse(),read,subject:'s',maxHits:width});
    actual.push(...result.items.map(x=>`${x.source.frame.revision}:${x.source.id}`));cursor=result.nextCursor;assert.ok(++steps<=10);
   }while(cursor);assert.deepEqual(actual,expected);checks++;
  }
 }assert.equal(checks,6144);
});
