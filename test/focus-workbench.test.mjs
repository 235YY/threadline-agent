import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {MaintenanceSession} from '../src/maintenance.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';
import {attentionId,keepAttention,attentionView} from '../src/attention.mjs';
import {canonical} from '../src/contracts.mjs';
import {wirePacket,expandOutput} from '../experiments/automated-study/protocol.mjs';
import {createFocusProjector as production,entryEligibleReason} from '../src/focus-projection.mjs';
import {focusWorkbench} from '../src/focus-workbench.mjs';
import {createFocusProjector as reference} from '../experiments/focus-reference/core.mjs';
import {X,A,E,F,M,R,U} from '../experiments/focus-reference/fixtures.mjs';
import {disk,event,note,frame,put,ref,code} from './helpers.mjs';
const purpose=(kind='active-task',ids=['a'])=>({kind,eventIds:ids,questionId:null,appliesTo:null});
const use=(id,target,fields={})=>({id,target:{kind:'material',ref:target},cue:'仍需核对的原文入口',presentation:'full',purposes:[purpose()],...fields});
const process=(id,fields={})=>({id,expectedRevision:0,label:`项目${id}`,body:'还在进行，不能把计划当回执',status:'active',world:'actual',intervals:[],basis:[],...fields});
const relation=(id,child,parent,fields={})=>({id,expectedRevision:0,type:'task-part-of',from:{id:child,revision:1},to:{id:parent,revision:1},status:'active',basis:[],...fields});
const identity=(kind,id)=>({kind,id});
const selectNew=(kind,id)=>({kind,id,path:[]});
const policy={maxReads:4,maxHits:4};
function setup(t,path=':memory:'){
 const store=new ContinuityStore(path,{clock:()=>Date.UTC(2026,10,5,12)});t.after(()=>store.close());
 const session=new ContinuitySession({store,subjectId:'synthetic-focus',attention:true});
 put(store,'seed',event('o'),frame(),note('m',[],{body:'只在旧条件下成立，不能当作当前事实。'}),note('n',[],{body:'第二份原文；尚未得到执行结果。'}));
 return {store,session,o:store.read('o'),w:store.read('qq'),m:store.read('m'),n:store.read('n'),seq:0,path};
}
const snapshot=s=>s.store.read(attentionId('synthetic-focus'));
const prepare=(s,args={})=>s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,workbenchMaterials:true,workbenchFocus:true,budgetBytes:131072,...args});
function output(p,opts={}){
 const attention={...keepAttention(),processes:opts.processes??[],relations:opts.relations??[],residency:{upsert:opts.upsert??[],remove:opts.remove??[]}};
 if(Object.hasOwn(opts,'select'))attention.focus={select:opts.select};
 return {packetId:p.packetId,options:[{id:'next',kind:opts.kind??'wait',payload:opts.payload??{}}],selected:'next',summary:'预置本地补丁，只检验程序边界',used:[],
  continuity:{changes:opts.changes??[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}};
}
function commit(s,opts={},p=prepare(s)){
 const id=`d${++s.seq}`;return s.session.commit({packet:p,output:output(p,opts),decisionId:id,requestId:`commit:${id}`});
}
const assignment=x=>({ref:ref(x),aspect:'belief'});
const ids=p=>p.payload.materials.map(m=>m.ref.id).sort();
const menu=(p,kind,id,path=[])=>{const m=p.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind===kind&&m.selection.id===id&&canonical(m.selection.path.map(e=>e.id))===canonical(path));assert.ok(m,`menu ${kind}:${id} ${path}`);return m.key;};
function seed(s,extra={}){return commit(s,{processes:[process('a')],upsert:[use('u',ref(s.m))],select:[selectNew('process','a')],...extra},prepare(s,{materials:[assignment(s.m),assignment(s.n)]}));}

test('同事务建任务/绑定材料/选择焦点；full不要求第二轮审批',t=>{
 const s=setup(t);seed(s);const p=prepare(s);
 assert.deepEqual(ids(p),['m']);assert.equal(snapshot(s).focus.selection[0].id,'a');
 assert.equal(p.payload.continuity.attention.focusSupport.enabled,true);
 assert.ok(p.instruction.includes('另可含focus'));assert.ok(!p.instruction.includes('self-directed允许显式full'));
});

test('切到交谈收原文，不暂停任务、不关闭感受/关切；恢复不重搜',t=>{
 const s=setup(t);seed(s,{changes:[{id:'feeling',expectedRevision:0,kind:'feeling',body:'仍想把礼物做好',status:'open',nature:'self-report'}],
  upsert:[use('u',ref(s.m)),{id:'feeling-use',target:{kind:'state',ref:{id:'feeling',revision:1}},cue:'仍在意',purposes:[purpose()]}]});
 let p=prepare(s);assert.equal(p.payload.continuity.foreground[0].ref.id,'feeling');
 commit(s,{select:[menu(p,'interaction','current')],kind:'respond',payload:{text:'晚饭想吃什么？'}},p);
 p=prepare(s);assert.deepEqual(ids(p),[]);assert.equal(snapshot(s).processes[0].status,'active');
 assert.equal(s.store.read('feeling').body,'仍想把礼物做好');assert.equal(p.payload.continuity.foreground[0].ref.id,'feeling');
 commit(s,{select:[menu(p,'process','a')]},p);assert.deepEqual(ids(prepare(s)),['m']);assert.equal(s.store.read('m').revision,1);
});

test('真实B/C/R/Z结构与固定条件关系跨焦点连续，切换不产生状态新版本',t=>{
 const s=setup(t),p=prepare(s,{mind:true,materials:[assignment(s.m)]});
 const make=(id,kind,mind)=>({id,expectedRevision:0,kind,body:`合成状态${id}，不代表已得到新回执`,status:'open',nature:'self-report',mind:{confidence:'tentative',...mind}});
 const states=[make('gift','concern',{role:'concern',orientation:'preserve'}),make('belief','appraisal',{role:'belief',alternatives:[]}),
  make('means','condition',{role:'condition',assessment:'unknown'}),
  make('forecast','expectation',{role:'expectation',action:{tool:'fixture.repair',args:{}},when:{condition:{id:'means',revision:1}},likelihood:'possible',effects:[{concern:{id:'gift',revision:1},relation:'supports',confidence:'tentative'}]}),
  make('ready','readiness',{role:'readiness',concerns:[{id:'gift',revision:1}],appraisals:[{id:'belief',revision:1}],conditions:[{id:'means',revision:1}],expectations:[{id:'forecast',revision:1}]})];
 commit(s,{processes:[process('a')],changes:states,select:[selectNew('process','a')],upsert:[use('u',ref(s.m)),...states.map(st=>({id:`state:${st.id}`,target:{kind:'state',ref:{id:st.id,revision:1}},cue:'连续状态',purposes:[purpose()]}))]},p);
 const before=states.map(st=>canonical(s.store.read(st.id)));let q=prepare(s,{mind:true});
 assert.ok(q.payload.continuity.mind);assert.equal(q.payload.continuity.foreground.length,5);
 commit(s,{select:[menu(q,'interaction','current')]},q);q=prepare(s,{mind:true});assert.deepEqual(ids(q),[]);
 assert.equal(q.payload.continuity.foreground.length,5);assert.deepEqual(states.map(st=>canonical(s.store.read(st.id))),before);
});

test('respond、redirect、新观察都不冒充焦点切换；null明确keep',t=>{
 const s=setup(t);seed(s);commit(s,{kind:'respond',payload:{text:'聊点别的'}});
 [s.o]=put(s.store,'new-event',event('next'));let p=prepare(s);assert.deepEqual(ids(p),['m']);
 commit(s,{select:null},p);assert.deepEqual(ids(prepare(s)),['m']);
});

test('旧多任务eventIds仍是OR：分别按所选任务使用，共享同版只交付一次',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('b')],upsert:[use('u',ref(s.m),{purposes:[purpose('active-task',['a','b'])]})]});
 let p=prepare(s);commit(s,{select:[menu(p,'process','a'),menu(p,'process','b')]},p);
 assert.deepEqual(ids(prepare(s)),['m']);
 p=prepare(s);commit(s,{processes:[process('a',{expectedRevision:1,status:'completed'})]},p);
 p=prepare(s);assert.deepEqual(ids(p),['m']);assert.ok(snapshot(s).residences.some(r=>r.id==='u'));
});

test('多父共享C：不同父路径只展开对应用途，不拉兄弟全文',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('b'),process('c')],relations:[relation('ca','c','a'),relation('cb','c','b')],
  upsert:[use('ua',ref(s.m),{purposes:[purpose('active-task',['c'])],focusUse:{consumer:identity('process','c'),owners:[identity('process','a')],context:[{id:'ca',revision:1}]}}),
    use('ub',ref(s.n),{purposes:[purpose('active-task',['c'])],focusUse:{consumer:identity('process','c'),owners:[identity('process','b')],context:[{id:'cb',revision:1}]}})],select:[selectNew('process','c')]});
 let p=prepare(s);assert.deepEqual(ids(p),[]);
 commit(s,{select:[menu(p,'process','c',['ca'])]},p);p=prepare(s);assert.deepEqual(ids(p),['m']);
 commit(s,{select:[menu(p,'process','c',['cb'])]},p);p=prepare(s);assert.deepEqual(ids(p),['n']);
 const c=snapshot(s).processes.find(p=>p.id==='c');assert.equal(c.revision,1);assert.equal(c.status,'active');
});

test('owner A结束只隐藏A用途，C及B用途继续；历史绑定仍可审计',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('b'),process('c')],
  upsert:[use('ua',ref(s.m),{purposes:[purpose('active-task',['c'])],focusUse:{consumer:identity('process','c'),owners:[identity('process','a')],context:null}}),
   use('ub',ref(s.m),{purposes:[purpose('active-task',['c'])],focusUse:{consumer:identity('process','c'),owners:[identity('process','b')],context:null}})],select:[selectNew('process','c')]});
 commit(s,{processes:[process('a',{expectedRevision:1,status:'completed'})]});const p=prepare(s);
 assert.deepEqual(ids(p),['m']);assert.equal(snapshot(s).processes.find(p=>p.id==='c').status,'active');
 assert.equal(p.payload.continuity.attention.residences.find(r=>r.id==='ua').delivery,'hidden');
 assert.ok(p.payload.continuity.attention.focusSupport.materialUses.some(u=>u.residenceId==='ua'&&u.reason==='owner-ended'));
});

test('暂停owner保入口；entry偏好、off-focus、context不匹配均不丢恢复点',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('c')],upsert:[use('u',ref(s.m),{purposes:[purpose('active-task',['c'])],focusUse:{consumer:identity('process','c'),owners:[identity('process','a')],context:null}})],select:[selectNew('process','c')]});
 commit(s,{processes:[process('a',{expectedRevision:1,status:'paused'})]});let p=prepare(s);assert.deepEqual(ids(p),[]);
 assert.equal(p.payload.continuity.attention.materials[0].delivery,'entry');assert.equal(p.payload.continuity.attention.focusSupport.materialUses[0].reason,'owner-paused');
 commit(s,{processes:[process('a',{expectedRevision:2})]});assert.deepEqual(ids(prepare(s)),['m']);
});

test('旧路径过期保留blocked且即时状态可提交；允许显式切到新焦点',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('c')],relations:[relation('ca','c','a')]});
 let p=prepare(s);commit(s,{select:[menu(p,'process','c',['ca'])]},p);
 commit(s,{processes:[process('a',{expectedRevision:1,status:'paused'})],changes:[{id:'still',expectedRevision:0,kind:'feeling',body:'还没想好，先保留',nature:'self-report'}]});
 p=prepare(s);assert.equal(p.payload.continuity.attention.focusSupport.blocked.length,1);assert.equal(s.store.read('still').body,'还没想好，先保留');
 assert.equal(snapshot(s).focus.selection[0].path[0].id,'ca');assert.equal(snapshot(s).relations[0].to.revision,1);
 commit(s,{select:[menu(p,'interaction','current')]},p);assert.equal(prepare(s).payload.continuity.attention.focusSupport.blocked.length,0);
});

test('猜菜单或刚变成过期的路径拒绝，状态/焦点/回复意图同事务回滚',t=>{
 const s=setup(t);seed(s);const before=canonical(snapshot(s));
 assert.throws(()=>commit(s,{select:['F99999'],changes:[{id:'bad',expectedRevision:0,kind:'feeling',body:'不能写一半',nature:'self-report'}],kind:'respond',payload:{text:'不会发出'}}),code('UNDELIVERED_FOCUS'));
 assert.equal(s.store.read('bad'),null);assert.equal(canonical(snapshot(s)),before);assert.equal(s.store.read(`d${s.seq}:response`),null);
});

test('同事务新选的路径若端点同时升版，整体拒绝而非悄悄当keep阻塞',t=>{
 const s=setup(t);seed(s,{processes:[process('a'),process('c')],relations:[relation('ca','c','a')]});
 const p=prepare(s),before=canonical(snapshot(s));
 assert.throws(()=>commit(s,{select:[menu(p,'process','c',['ca'])],processes:[process('a',{expectedRevision:1,status:'paused'})],changes:[{id:'atomic',expectedRevision:0,kind:'feeling',body:'不能半写',nature:'self-report'}]},p),code('FOCUS_PATH_BLOCKED'));
 assert.equal(canonical(snapshot(s)),before);assert.equal(s.store.read('atomic'),null);
});

test('未知消费者、别人的状态、伪造路径和未读材料不能借focusUse绕过',t=>{
 const s=setup(t);seed(s);
 assert.throws(()=>commit(s,{upsert:[use('guess',ref(s.n),{focusUse:{consumer:identity('process','unknown'),owners:[],context:null}})]},prepare(s,{materials:[assignment(s.n)]})),code('UNREAD_FOCUS_SCOPE'));
 assert.throws(()=>commit(s,{upsert:[use('guess',ref(s.n),{focusUse:{consumer:identity('process','a'),owners:[],context:null}})]}),code('UNREAD_MATERIAL'));
 assert.throws(()=>commit(s,{upsert:[use('guess',ref(s.n),{focusUse:{consumer:identity('process','a'),owners:[],context:[{id:'invented',revision:1}]}})]},prepare(s,{materials:[assignment(s.n)]})),code('FOCUS_PATH_BLOCKED'));
 assert.equal(snapshot(s).residences.length,1);
});

test('启用后不能通过省略capability绕过；旧模式不能偷偷填focus或scope',t=>{
 const s=setup(t);const off=prepare(s,{workbenchFocus:false});
 assert.throws(()=>commit(s,{select:[]},off),code('FOCUS_CAPABILITY'));seed(s);
 assert.throws(()=>prepare(s,{workbenchFocus:false}),code('FOCUS_CAPABILITY'));
 assert.throws(()=>prepare(s,{workbenchMaterials:false}),code('FOCUS_CAPABILITY'));
});

test('self-directed不自动抢前台，明确选材料念头入口才展开；移除不删除原文',t=>{
 const s=setup(t);seed(s,{processes:[],upsert:[use('idea',ref(s.m),{purposes:[purpose('self-directed',[])]})],select:[]});
 let p=prepare(s);assert.deepEqual(ids(p),[]);commit(s,{select:[menu(p,'residence','idea')]},p);assert.deepEqual(ids(prepare(s)),['m']);
 commit(s,{remove:['idea']});p=prepare(s);assert.deepEqual(ids(p),[]);assert.equal(p.payload.continuity.attention.focusSupport.blocked.length,1);assert.equal(s.store.read('m').revision,1);
});

test('同事务用途交叉引用与排列无关；移除显式owner只结束依赖它的用途',t=>{
 const s=setup(t);
 seed(s,{upsert:[use('dependent',ref(s.m),{focusUse:{consumer:identity('process','a'),owners:[identity('residence','anchor-use')],context:null}}),
  use('anchor-use',ref(s.n),{purposes:[purpose('self-directed',[])]})]});
 let p=prepare(s);assert.deepEqual(ids(p),['m']);
 commit(s,{remove:['anchor-use']},p);p=prepare(s);assert.deepEqual(ids(p),[]);
 assert.ok(p.payload.continuity.attention.focusSupport.materialUses.some(u=>u.residenceId==='dependent'&&u.reason==='owner-ended'));
 assert.equal(snapshot(s).processes[0].status,'active');assert.equal(s.store.read('m').revision,1);
});

test('只改entry/full不悄悄清掉原scope；null拒绝而不是默认为无约束',t=>{
 const s=setup(t),scope={consumer:identity('process','a'),owners:[],context:null};
 seed(s,{upsert:[use('u',ref(s.m),{focusUse:scope})]});
 commit(s,{upsert:[use('u',ref(s.m),{presentation:'entry'})]});assert.deepEqual(snapshot(s).residences[0].focusUse,scope);
 commit(s,{upsert:[use('u',ref(s.m))]});assert.deepEqual(ids(prepare(s)),['m']);assert.deepEqual(snapshot(s).residences[0].focusUse,scope);
 assert.throws(()=>commit(s,{upsert:[use('u',ref(s.m),{focusUse:null})]}),code('FOCUS_SHAPE'));
});

test('同名用途重建不会让旧焦点自动指向新用途，必须明确重选',t=>{
 const s=setup(t);seed(s,{processes:[],upsert:[use('idea',ref(s.m),{purposes:[purpose('self-directed',[])]})],select:[selectNew('residence','idea')]});
 const old=snapshot(s).focus.selection[0].token;assert.deepEqual(ids(prepare(s)),['m']);
 commit(s,{remove:['idea']});commit(s,{upsert:[use('idea',ref(s.n),{purposes:[purpose('self-directed',[])]})]},prepare(s,{materials:[assignment(s.n)]}));
 let p=prepare(s);assert.deepEqual(ids(p),[]);assert.equal(p.payload.continuity.attention.focusSupport.blocked.length,1);
 assert.notEqual(snapshot(s).residences[0].focusToken,old);
 commit(s,{select:[menu(p,'residence','idea')]},p);assert.deepEqual(ids(prepare(s)),['n']);
});

test('owner用途同名重建不复活旧依赖，明确重新声明才能绑定新代际',t=>{
 const s=setup(t),scope={consumer:identity('process','a'),owners:[identity('residence','owner')],context:null};
 seed(s,{upsert:[use('dependent',ref(s.m),{focusUse:scope}),use('owner',ref(s.n),{purposes:[purpose('self-directed',[])]})]});
 const old=snapshot(s).residences.find(r=>r.id==='dependent').focusPins[0].token;
 commit(s,{remove:['owner']});commit(s,{upsert:[use('owner',ref(s.n),{purposes:[purpose('self-directed',[])]})]},prepare(s,{materials:[assignment(s.n)]}));
 let p=prepare(s);assert.deepEqual(ids(p),[]);assert.equal(p.payload.continuity.attention.focusSupport.materialUses.find(u=>u.residenceId==='dependent').reason,'owner-stale');
 assert.equal(snapshot(s).residences.find(r=>r.id==='dependent').focusPins[0].token,old);
 commit(s,{upsert:[use('dependent',ref(s.m),{presentation:'entry'})]},p);commit(s,{upsert:[use('dependent',ref(s.m))]});p=prepare(s);assert.deepEqual(ids(p),[]);
 assert.equal(snapshot(s).residences.find(r=>r.id==='dependent').focusPins[0].token,old);
 commit(s,{upsert:[use('dependent',ref(s.m),{focusUse:scope})]},p);assert.deepEqual(ids(prepare(s)),['m']);
});

test('多个已退出代际的诊断不依赖用途排列顺序',()=>{
 const rs=['a','b'].map((token,i)=>({...use(`r${i}`,{id:'m',revision:1},{purposes:[purpose('active-task',['p'])],focusUse:{consumer:identity('process','p'),owners:[identity('residence','gone')],context:null}}),focusToken:`current-${i}`,focusPins:[{id:'gone',token}]}));
 const graph={subject:'synthetic',revision:4,processes:[{id:'p',revision:1,status:'active',world:'actual',label:'项目'}],relations:[],questions:[],residences:rs,focus:{format:'pinned-focus-v1',selection:[{kind:'process',id:'p',path:[]}]}};
 const read=()=>({type:'note',id:'m',revision:1,body:'旧资料'});
 assert.deepEqual(focusWorkbench(graph,{read}).metadata,focusWorkbench({...graph,residences:[...rs].reverse()},{read}).metadata);
});

test('固定旧版与新头提示保留；焦点切换不把绑定升级或加深回想',t=>{
 const s=setup(t);seed(s);put(s.store,'revise',note('m',[],{expectedRevision:1,body:'新理解，仅作为新版本'}));
 let p=prepare(s);assert.equal(p.payload.materials[0].ref.revision,1);assert.equal(p.payload.materials[0].currentHead.ref.revision,2);
 commit(s,{select:[menu(p,'interaction','current')]},p);p=prepare(s);commit(s,{select:[menu(p,'process','a')]},p);
 assert.equal(prepare(s).payload.materials[0].ref.revision,1);assert.deepEqual(s.store.uses('m'),[]);
});

test('完整messages预算仍是最终准入，失败保留焦点和全部绑定',t=>{
 const s=setup(t);seed(s);const p=prepare(s),before=canonical(snapshot(s));
 assert.equal(p.bytes,Buffer.byteLength(canonical(p.messages)));
 assert.throws(()=>prepare(s,{budgetBytes:p.bytes-1}),code('WORKBENCH_REQUIRED_OVERFLOW'));
 assert.equal(canonical(snapshot(s)),before);assert.deepEqual(ids(prepare(s)),['m']);
});

test('薄接口只暴露同一焦点通道，空字段keep且不混回旧residency通道',t=>{
 const s=setup(t);seed(s);const p=prepare(s),wire=wirePacket(p,'compact');
 assert.ok(wire.instruction.includes('focusSupport.menu'));assert.ok(!wire.instruction.includes('self-directed允许显式full'));
 const raw=JSON.stringify({packetId:wire.packetId,choice:{kind:'wait',payload:{}},attention:{...keepAttention(),focus:{select:[menu(p,'interaction','current')]}}});
 const expanded=expandOutput(wire,raw);assert.deepEqual(expanded.continuity.residency,{add:[],remove:[]});
 s.session.commit({packet:p,output:expanded,decisionId:'thin',requestId:'thin'});assert.deepEqual(ids(prepare(s)),[]);
});

test('重启保留焦点/固定版，旧并发包不能覆盖，重复提交不重复改写',t=>{
 const path=disk(t),s=setup(t,path);seed(s);const p=prepare(s),out=output(p,{select:[menu(p,'interaction','current')]});
 const args={packet:p,output:out,decisionId:'once',requestId:'once'};s.session.commit(args);const after=canonical(snapshot(s));
 s.session.commit(args);assert.equal(canonical(snapshot(s)),after);
 assert.throws(()=>commit(s,{select:[menu(p,'process','a')]},p),code('STALE_SUBJECT'));
 s.store.close();const reopened=new ContinuityStore(path),session=new ContinuitySession({store:reopened,subjectId:'synthetic-focus',attention:true});
 try{const q=session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,workbenchMaterials:true,workbenchFocus:true,budgetBytes:131072});assert.deepEqual(ids(q),[]);assert.equal(reopened.read('m').revision,1);}finally{reopened.close();}
});

test('后台维护继承焦点能力且keep不清理前台选择',async t=>{
 const s=setup(t);seed(s);const maintenance=new MaintenanceSession({store:s.store,subjectId:'synthetic-focus'});
 const p=maintenance.inspect();assert.equal(p.job.packet.payload.continuity.attention.focusSupport.enabled,true);
 const result=await maintenance.tick({authorize:()=>true,invoke:input=>({packetId:input.packetId,disposition:'keep',summary:'不改，不编造',changes:[],attention:keepAttention(),noteUpdates:[],observations:[],requests:[]})});
 assert.equal(result.status,'adopted');assert.deepEqual(ids(prepare(s)),['m']);
});

test('后台提案晚到不能覆盖后来切换的焦点',async t=>{
 const s=setup(t);seed(s);const maintenance=new MaintenanceSession({store:s.store,subjectId:'synthetic-focus'});let input,release,entered;
 const observed=new Promise(resolve=>{entered=resolve;});
 const pending=maintenance.tick({authorize:()=>true,invoke:received=>{input=received;entered();return new Promise(resolve=>{release=resolve;});}});
 await Promise.race([observed,pending.then(()=>{throw Error('maintenance did not enter injected test client');})]);
 const p=prepare(s);commit(s,{select:[menu(p,'interaction','current')]},p);
 release({packetId:input.packetId,disposition:'update',summary:'旧后台清理提案',changes:[],attention:{...keepAttention(),residency:{upsert:[],remove:['u']}},noteUpdates:[],observations:[],requests:[]});
 const result=await pending;assert.notEqual(result.status,'adopted');assert.ok(snapshot(s).residences.some(r=>r.id==='u'));assert.equal(snapshot(s).focus.selection[0].kind,'interaction');
});

test('run重入把焦点能力纳入指纹，同模式不再调用，换模式不能偷用旧结果',async t=>{
 const s=setup(t);let calls=0;
 const args={currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,workbenchMaterials:true,workbenchFocus:true,budgetBytes:131072,requestId:'run-focus',decisionId:'run-focus',
  invoke:input=>{calls++;return output(input,{select:[]});}};
 await s.session.run(args);const replay=await s.session.run(args);assert.equal(replay.resumed,true);assert.equal(calls,1);
 await assert.rejects(s.session.run({...args,workbenchFocus:false}),code('DECISION_ID_COLLISION'));assert.equal(calls,1);
});

test('大目录保留当前共享消费者的父路径；新查到的过程可优先出现在菜单',()=>{
 const processes=Array.from({length:80},(_,i)=>({id:`p${String(i).padStart(2,'0')}`,revision:1,label:`项目${i}`,world:'actual',status:'active',intervals:[]}));
 const graph={subject:'synthetic-focus',revision:1,processes,relations:[{id:'ca',revision:1,type:'task-part-of',status:'active',from:ref(processes[79]),to:ref(processes[78])}],questions:[],residences:[use('u',{id:'m',revision:1},{purposes:[purpose('active-task',['p79'])]})]};
 const read=()=>({type:'note',id:'m',revision:1,body:'旧条件'});
 const a=focusWorkbench(graph,{read}).metadata;assert.ok(a.menu.some(m=>m.selection.id==='p79'&&m.selection.path[0]?.id==='ca'));
 const path=a.menu.find(m=>m.selection.id==='p79'&&m.selection.path.length);assert.equal(path.via[0].parent.id,'p78');assert.ok(a.omittedMenu>0);
 const b=focusWorkbench(graph,{read,priorityProcessIds:['p77']}).metadata;assert.ok(b.menu.some(m=>m.selection.id==='p77'));
});

test('入口谓词涵盖暂停/不匹配，结束/释放/失效不伪装成可恢复',()=>{
 for(const r of ['use-parked','consumer-paused','owner-paused','entry-preference','off-focus','context-mismatch'])assert.equal(entryEligibleReason(r),true);
 for(const r of ['released','consumer-stale','consumer-ended','owner-stale','owner-ended','selected'])assert.equal(entryEligibleReason(r),false);
 assert.throws(()=>entryEligibleReason('guessed'),code('FOCUS_SHAPE'));
});

test('调试显示输入选择/blocked/用途原因与提交前后，默认不导出正文',t=>{
 const path=disk(t),s=setup(t,path);seed(s);const p=prepare(s),d=commit(s,{select:[menu(p,'interaction','current')]},p);
 const archive=new DebugArchive(path);try{const audit=archive.inspect({decisionId:d.id});assert.equal(audit.input.focus.enabled,true);assert.equal(audit.focusChange.after.selection[0].kind,'interaction');assert.equal(JSON.stringify(audit).includes('只在旧条件下成立'),false);}finally{archive.close();s.store.close();}
});

test('schema9默认拒绝；显式审核副本升级保留全部原版本及旧焦点前历史',t=>{
 const path=disk(t),s=setup(t,path);
 commit(s,{processes:[process('a')],upsert:[use('u',ref(s.m))]},prepare(s,{workbenchFocus:false,materials:[assignment(s.m)]}));
 const old=canonical(s.store.read('m')),legacyFrame=canonical(snapshot(s));s.store.close();
 const DB=sqlite.Database??sqlite.DatabaseSync,db=new DB(path);db.exec('PRAGMA user_version=9');db.close();
 assert.throws(()=>new ContinuityStore(path),code('MIGRATION_REQUIRED'));
 const check=new DB(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,9);check.close();
 const migrated=new ContinuityStore(path,{migrateV9:true});try{assert.equal(canonical(migrated.read('m')),old);assert.equal(canonical(migrated.read(attentionId('synthetic-focus'))),legacyFrame);assert.equal(migrated.read(attentionId('synthetic-focus')).focus,undefined);}finally{migrated.close();}
});

test('超过菜单深度仍标出未枚举，不能当成不存在更深的父层',()=>{
 const processes=Array.from({length:7},(_,i)=>({id:`p${i}`,revision:1,label:`项目${i}`,world:'actual',status:'active'}));
 const graph={subject:'synthetic-focus',revision:1,processes,relations:processes.slice(0,-1).map((p,i)=>({id:`e${i}`,revision:1,type:'task-part-of',status:'active',from:ref(p),to:ref(processes[i+1])})),questions:[],residences:[]};
 const result=focusWorkbench(graph,{read:()=>null});assert.equal(result.metadata.pathDepthLimited,true);assert.ok(result.metadata.omittedMeaning.includes('unknown'));
});

test('菜单不会把别的主体状态作为可用消费者',t=>{
 const s=setup(t);seed(s);const other=new ContinuitySession({store:s.store,subjectId:'other',attention:true});
 const p=other.prepare({currentEvent:ref(s.o),workspace:ref(s.w),budgetBytes:65536});
 other.commit({packet:p,output:output(p,{changes:[{id:'foreign',expectedRevision:0,kind:'feeling',body:'其他主体的状态',nature:'self-report'}]}),decisionId:'other-decision',requestId:'other-decision'});
 const mine=prepare(s,{materials:[assignment(s.n)]});assert.ok(!mine.payload.continuity.attention.focusSupport.menu.some(m=>m.selection.id==='foreign'));
 assert.throws(()=>commit(s,{upsert:[use('unknown-owner',ref(s.n),{focusUse:{consumer:identity('process','a'),owners:[identity('state','foreign')],context:null}})]},mine),code('UNREAD_FOCUS_SCOPE'));
});

test('生产纯投影与保留参考在同一声明输入上完全一致',()=>{
 for(let mask=0;mask<32;mask++){
  const x=X({edges:[E('ca','c','a'),E('cb','c','b')],materials:[M('m',{requires:mask&1?[R('n')]:[]}),M('n')]});
  const args={focus:mask&2?[F('c',['ca'])]:[F('b')],uses:[U('u','c','m',{status:mask&4?'parked':'open',owners:mask&8?[{kind:'process',id:'a',epoch:'1'}]:[],presentation:mask&16?'entry':'full'})]};
  const a=production(x),b=reference(x);assert.deepEqual(a.project(a.create(args)),b.project(b.create(args)));
 }
});
