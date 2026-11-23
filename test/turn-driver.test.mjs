import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,event,frame,put,ref,note} from './helpers.mjs';

const MIN=60*1000, t0=Date.UTC(2026,10,7,10,0,0);
const attention=()=>({...keepAttention()});
const continuity=()=>({changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()});
const reflectionContinuity=()=>({changes:[],residency:{add:[],remove:[]},attention:attention()});
const output=(p,option)=>({packetId:p.packetId,options:[option],selected:option.id,summary:'夹具只验证接线',used:[],continuity:continuity()});
const reflect=(p,kind='wait',payload={})=>({packetId:p.packetId,options:[{id:'o',kind,payload}],selected:'o',summary:'夹具只验证接线',used:[],continuity:reflectionContinuity()});
const respond=text=>p=>JSON.stringify(p.stage==='reflection'?reflect(p):output(p,{id:'say',kind:'respond',payload:{text}}));
const lookup=terms=>p=>JSON.stringify(p.stage==='reflection'?reflect(p):output(p,{id:'q',kind:'lookup',payload:{terms}}));
const lookupPerson=name=>p=>JSON.stringify(p.stage==='reflection'?reflect(p):output(p,{id:'q',kind:'lookup',payload:{person:name}}));
const reflectLookup=terms=>p=>JSON.stringify(reflect(p,'lookup',{terms}));
const reflectRespond=text=>p=>JSON.stringify(reflect(p,'respond',{text}));
const waitUntil=wakeAt=>p=>JSON.stringify(p.stage==='reflection'?reflect(p,'wait',{wakeAt}):output(p,{id:'w',kind:'wait',payload:{mode:'until',wakeAt}}));

function setup(t,{decide,rhythm,materialsFor,allowedActionTools,workspaceId='qq'}={}){
  const holder=memory(t),store=holder.store;
  new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
  const w=store.read(workspaceId)??put(store,'workspace',frame({id:workspaceId}))[0];
  const driver=new TurnDriver({store,subjectId:'actor',workspace:ref(w),identity:'你是小栈。',decide,rhythm,materialsFor,allowedActionTools});
  return {store,w,driver};
}

test('一条消息：节律给机会 → 她决定回应 → 出站；不重复处理',async t=>{
  let n=0;const s=setup(t,{decide:p=>{n++;return respond('在的。')(p);}});
  const first=await s.driver.tick({now:t0});
  assert.equal(first.wake,false,'第一次只是记下醒来时间，没有观察就不打扰');
  s.driver.ingest({key:'m1',body:'在吗',at:t0});
  const r=await s.driver.tick({now:t0+4*MIN});
  assert.equal(r.wake,true);assert.equal(r.action,'decided');assert.equal(r.choice,'respond');
  const outbox=s.driver.takeOutbox();
  assert.equal(outbox.length,1);assert.equal(outbox[0].kind,'respond');assert.equal(outbox[0].text,'在的。');assert.ok(outbox[0].response?.id);
  assert.equal(s.store.subjectInbox({subjectId:'actor',pendingOnly:false}).items.length,1,'观察已入账');
  assert.equal(s.store.subjectInbox({subjectId:'actor',pendingOnly:true}).total,0,'观察已被这一轮处理');
  const again=await s.driver.tick({now:t0+4*MIN});
  assert.equal(again.wake,false,'同一刻不重复唤醒');
  assert.equal(n,1);
});

test('她选择查阅：宿主执行一次，她再决定是否回应',async t=>{
  let n=0;const decide=p=>{n++;return n===1?lookup(['在吗'])(p):respond('我在。')(p);};
  const s=setup(t,{decide});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'m2',body:'在吗',at:t0});
  const r=await s.driver.tick({now:t0+4*MIN});
  assert.equal(n,2,'先查一次，再决定');
  assert.equal(r.choice,'respond');assert.equal(s.driver.takeOutbox()[0].text,'我在。');
});

test('她选择等待：到点才醒，没到点不醒；到点醒来是反思而不是编一条假观察',async t=>{
  const wakeAt=t0+30*MIN;let n=0;
  const base=waitUntil(wakeAt);const decide=p=>{n++;return base(p);};
  const s=setup(t,{decide});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'m3',body:'晚点再说',at:t0});
  const first=await s.driver.tick({now:t0+4*MIN});
  assert.equal(first.choice,'wait');assert.equal(s.driver.state.nextWakeAt,wakeAt);
  const early=await s.driver.tick({now:t0+10*MIN});
  assert.equal(early.wake,false,'等没到点不醒');
  const before=[...s.store.all('event')].length;
  const due=await s.driver.tick({now:wakeAt+MIN});
  assert.equal(due.wake,true);assert.equal(due.action,'reflected','醒来但没有新观察：是反思，不是新事件');
  assert.equal([...s.store.all('event')].length,before,'反思不产生事件');
  assert.equal(n,2,'等待决定 + 反思各一次');
});

test('同一观察重复投递不重复处理；节律到点才反思',async t=>{
  let n=0;const s=setup(t,{decide:p=>{n++;return respond('嗯')(p);}});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'dup',body:'同一条',at:t0});
  s.driver.ingest({key:'dup',body:'同一条',at:t0});
  assert.equal(s.store.subjectInbox({subjectId:'actor',pendingOnly:true}).total,1,'幂等入账');
  await s.driver.tick({now:t0+4*MIN});
  assert.equal(n,1);
  const late=await s.driver.tick({now:t0+4*MIN});
  assert.equal(late.wake,false);
  const beat=await s.driver.tick({now:t0+35*MIN});
  assert.equal(beat.wake,true);assert.equal(beat.reason,'beat');assert.equal(beat.action,'reflected');
  assert.equal(n,2,'到点才反思，不会因为空闲反复叫');
});

test('预算门：她还能被事件叫醒，但不再自动做节律性思考',async t=>{
  let n=0;const s=setup(t,{rhythm:{dailyCallCap:1},decide:p=>{n++;return respond('钱要省着用')(p);}});
  await s.driver.tick({now:t0});                       // 第一次只是记下醒来时间
  s.driver.ingest({key:'b1',body:'第一句',at:t0});
  await s.driver.tick({now:t0+4*MIN});
  assert.equal(n,1);assert.equal(s.driver.state.callsToday,1);
  s.driver.ingest({key:'b2',body:'第二句',at:t0+8*MIN});
  const r=await s.driver.tick({now:t0+8*MIN});
  assert.equal(r.wake,true);assert.equal(r.action,'budget-blocked');assert.equal(n,1,'预算耗尽不再调用模型');
});

test('快照恢复：重启后她仍记得上一次醒来与下一次等待',async t=>{
  const s=setup(t,{decide:waitUntil(t0+60*MIN)});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'r1',body:'等我一下',at:t0});
  await s.driver.tick({now:t0+4*MIN});
  const snap=s.driver.snapshot();
  let n=0;
  const fresh=new TurnDriver({store:s.store,subjectId:'actor',workspace:ref(s.w),identity:'你是小栈。',decide:p=>{n++;return respond('好')(p);}});
  fresh.restore(snap);
  const r=await fresh.tick({now:t0+10*MIN});
  assert.equal(r.wake,false,'恢复后仍按上次醒来的间隔判断');
  assert.equal(fresh.state.nextWakeAt,t0+60*MIN);
  assert.equal(n,0);
});

test('材料由宿主提供，程序不猜：materialsFor 的引用原样进入决策包',async t=>{
  let seen=null;const decide=p=>{if(p.stage==='reflection')return JSON.stringify(reflect(p));seen=p;return JSON.stringify(output(p,{id:'say',kind:'respond',payload:{text:'好'}}));};
  const s=setup(t,{decide,materialsFor:({store})=>{
    put(store,'note:material',note('material',[],{body:'她之前写过的一页笔记'}));
    return [{ref:ref(store.read('material')),aspect:'belief'}];
  }});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'f1',body:'在吗',at:t0});
  await s.driver.tick({now:t0+4*MIN});
  assert.equal(seen.payload.materials[0].ref.id,'material');
  assert.deepEqual(seen.payload.materials[0].aspects,['belief']);
});

test('反思轮里她可以查阅，查阅结果用于下一次反思',async t=>{
  let n=0;const s=setup(t,{decide:p=>{n++;return n===1?reflectLookup(['在吗'])(p):reflectRespond('想起来了。')(p);}});
  await s.driver.tick({now:t0});
  const before=[...s.store.all('event')].length;
  const r=await s.driver.tick({now:t0+30*MIN});
  assert.equal(r.wake,true);assert.equal(r.reason,'beat');
  assert.equal(r.action,'reflected');assert.equal(r.choice,'respond');assert.equal(n,2);
  assert.equal(r.lookups.length,1);
  assert.equal([...s.store.all('event')].length,before,'反思与查阅都不写世界事件');
  assert.equal(s.driver.takeOutbox()[0].text,'想起来了。');
});

test('想到一个人可以接着查：一轮里先 terms 再 person，最后再决定',async t=>{
  let n=0;const s=setup(t,{decide:p=>{n++;if(n===1)return lookup(['小红'])(p);if(n===2)return lookupPerson('小红')(p);return respond('嗯')(p);}});
  put(s.store,'about:hong',note('about:hong',[],{body:'小红最近在准备考试',status:'current',
    scope:{scenes:['private:1'],people:['小红'],validFrom:null,validUntil:null}}));
  put(s.store,'hong:says',event('hong:says',{body:'小红说周末想休息',origin:'reported',scene:'private:1',actor:'小红'}));
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'h1',body:'小红今天来了',scene:'private:1',at:t0});
  const r=await s.driver.tick({now:t0+4*MIN});
  assert.equal(n,3,'先查词，再查人，再决定');
  assert.equal(r.lookups.length,2);
  assert.equal(r.choice,'respond');assert.equal(s.driver.takeOutbox()[0].text,'嗯');
});

test('节律状态落成版本化 note，重启后接得上',async t=>{
  const s=setup(t,{decide:waitUntil(t0+60*MIN)});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'p1',body:'等我',at:t0});
  await s.driver.tick({now:t0+4*MIN});
  const saved=s.driver.persistState();
  const note=s.store.read(saved.id,saved.revision);
  assert.equal(note.kind,'skill');assert.match(note.body,/rhythm-state-v1/);
  let n=0;
  const fresh=new TurnDriver({store:s.store,subjectId:'actor',workspace:ref(s.w),identity:'你是小栈。',decide:p=>{n++;return respond('好')(p);}});
  assert.equal(fresh.loadState(),true);
  assert.deepEqual(fresh.state,s.driver.state);
  const r=await fresh.tick({now:t0+10*MIN});
  assert.equal(r.wake,false,'恢复后按上次醒来时间判断');assert.equal(fresh.state.nextWakeAt,t0+60*MIN);assert.equal(n,0);
});

test('动作只生成待执行请求，真实回执回来才终态',async t=>{
  const s=setup(t,{allowedActionTools:['send_message'],decide:p=>p.stage==='reflection'?JSON.stringify(reflect(p)):
    JSON.stringify(output(p,{id:'a',kind:'act',payload:{tool:'send_message',args:{to:'qq:1'}}}))});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'a1',body:'帮我说一句',at:t0});
  const r=await s.driver.tick({now:t0+4*MIN});
  assert.equal(r.choice,'act');
  const out=s.driver.takeOutbox()[0];assert.equal(out.kind,'act');assert.equal(out.tool,'send_message');
  assert.equal(s.store.read(out.action.id).status,'proposed','动作尚未执行');
  const receipt=s.driver.applyReceipt({action:out.action,status:'succeeded',body:'已发送',eventId:'receipt:send:1'});
  assert.equal(s.store.read(out.action.id).status,'succeeded');assert.equal(receipt.replayed,undefined);
});

test('她可以选择不回应：沉默是结果，不是失败',async t=>{
  let seen=null;const s=setup(t,{decide:p=>{if(p.stage!=='reflection')seen=p;return p.stage==='reflection'?JSON.stringify(reflect(p)):JSON.stringify(output(p,{id:'o',kind:'pause',payload:{}}));}});
  await s.driver.tick({now:t0});
  s.driver.ingest({key:'silent1',body:'不想回也可以',at:t0});
  const r=await s.driver.tick({now:t0+4*MIN});
  assert.equal(r.action,'decided');assert.equal(r.choice,'pause');assert.equal(r.silent,true);
  assert.match(seen.instruction,/不回应/,'协议明确告诉她可以沉默');
  assert.deepEqual(s.driver.takeOutbox(),[]);
  assert.equal(s.store.subjectInbox({subjectId:'actor',pendingOnly:true}).total,0,'观察已处理');
});