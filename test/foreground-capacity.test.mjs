import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId,keepAttention,advanceAttention,emptyAttention} from '../src/attention.mjs';
import {canonical} from '../src/contracts.mjs';
import {memory,put,event,frame,ref,code} from './helpers.mjs';

const policy={maxReads:4,maxHits:4};
function setup(t,{maxForeground=2}={}){
  const store=memory(t).store;
  const session=new ContinuitySession({store,subjectId:'person',attention:true,maxForeground});
  const [o,w]=put(store,'initial',event('o1'),frame());
  return {store,session,o,w,seq:0};
}
const state=(id,body='仍有一点失落',fields={})=>({id,expectedRevision:0,kind:'feeling',body,status:'open',nature:'self-report',...fields});
const process=(id,fields={})=>({id,expectedRevision:0,label:id,body:`过程 ${id}`,status:'active',world:'actual',intervals:[{start:null,end:null}],basis:[],...fields});
const purpose=(kind,fields={})=>({kind,eventIds:[],questionId:null,appliesTo:null,...fields});
const residence=(id,target,kind='state',purposes=[purpose('self-directed')],revision=1)=>({id,target:{kind,ref:{id:target,revision}},cue:`入口 ${target}`,purposes});
const processResidence=(id,pid,purposes=[purpose('active-task',{eventIds:[pid]})])=>({id,target:{kind:'process',ref:{id:pid,revision:1}},cue:`过程 ${pid}`,purposes});
const legacyStateResidence=(id,target)=>({id,target:{kind:'state',ref:{id:target,revision:1}},cue:`旧驻留 ${target}`,purposes:[purpose('active-task')]});
const patch=extra=>({...keepAttention(),...extra});
function prepare(s,fields={}){return s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,budgetBytes:65536,...fields});}
function output(packet,{changes=[],attention=keepAttention(),kind='wait',payload={},residency={add:[],remove:[]}}={}){
  return {packetId:packet.packetId,options:[{id:'a',kind,payload}],selected:'a',summary:'手工给定的结构测试，不是模型心理或语义证据',used:[],
    continuity:{changes,residency,expressionChoice:null,observationDisposition:'handled',attention}};
}
function commit(s,fields={},packet=prepare(s),extra={}){
  const id=`d${++s.seq}`;
  return s.session.commit({packet,output:output(packet,fields),decisionId:id,requestId:`commit:${id}`,...extra});
}
function next(s){const id=`o${++s.seq}`;[s.o]=put(s.store,`append:${id}`,event(id));return s;}
function snapshot(s){return s.store.read(attentionId('person'));}
function decisions(s){return [...s.store.all('decision')].filter(d=>d.input?.payload?.continuity?.subject?.id==='person');}
const recover={foregroundRecovery:true};
const plainState=id=>({id,revision:1,type:'personal_state',subject:'person',kind:'feeling',body:`状态 ${id}`,status:'open',nature:'self-report'});
const readStates=records=>(id,revision)=>records[id]??null;
const emptyDelta=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});
const reclaimFrame=residences=>({...emptyAttention('person'),residences});
function reclaimEnv(records,extra={}){
  return {read:readStates(records),at:1,maxForeground:2,foregroundRecovery:true,changedStateIds:[],
    memoryRefs:[],processRefs:[],relationRefs:[],questionRefs:[],stateRefs:[],observations:[],
    residenceIds:Object.keys(records),...extra};
}
// F-REV1-1: a purpose that names a process endpoint is a real work binding even when its
// kind label is not active-task (self-directed etc.); only truly ordinary desk states are
// reclaimable.
test('process-bound 非 active-task purpose 不被回收；普通最旧 state 仍可回收',()=>{
  const records={old:plainState('old'),bound:plainState('bound'),newer:plainState('newer')};
  const frame=reclaimFrame([
    residence('r-old','old'),
    residence('r-bound','bound','state',[purpose('self-directed',{eventIds:['p1']})]),
    residence('r-newer','newer')
  ]);
  const diagnostics=[];
  const next=advanceAttention(frame,emptyDelta(),reclaimEnv(records,{onCapacityEviction:ids=>diagnostics.push([...ids])}));
  assert.deepEqual(next.residences.map(r=>r.id),['r-bound','r-newer'],'process-bound residence stays; oldest ordinary desk state is dropped');
  assert.deepEqual(diagnostics,[['r-old']]);
  assert.throws(()=>advanceAttention(frame,emptyDelta(),reclaimEnv(records,{foregroundRecovery:false})),code('FOREGROUND_CAPACITY'),'background/no-opt-in paths keep zero reclaim');
});

// F-REV1-2: protecting only "residence upserted this turn" is insufficient: a state changed
// in the commit but not re-upserted as a residence is still this-turn state and must stay.
test('本轮 changedStateIds 的 state residence 不被回收（即使未 upsert residence）',()=>{
  const records={changed:plainState('changed'),other:plainState('other')};
  const frame=reclaimFrame([residence('r-changed','changed'),residence('r-other','other')]);
  const diagnostics=[];
  const next=advanceAttention(frame,emptyDelta(),reclaimEnv(records,{maxForeground:1,changedStateIds:['changed'],onCapacityEviction:ids=>diagnostics.push([...ids])}));
  assert.deepEqual(next.residences.map(r=>r.id),['r-changed'],'changed state stays; the other oldest state is the bounded reclaim');
  assert.deepEqual(diagnostics,[['r-other']]);
  const allChanged=reclaimFrame([residence('r-changed','changed'),residence('r-other','other')]);
  assert.throws(()=>advanceAttention(allChanged,emptyDelta(),reclaimEnv(records,{maxForeground:1,changedStateIds:['changed','other']})),code('FOREGROUND_CAPACITY'),'no safe candidate remains fail-closed');
});


test('已满的普通 QQ 回合只移除最旧 self-directed 驻留，状态正文与版本不变',t=>{
  const s=setup(t);
  commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[residence('ra','a'),residence('rb','b')],remove:[]}})});
  const before=canonical(s.store.read('a'));
  assert.equal(snapshot(s).residences.length,2);
  next(s);
  commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.equal(snapshot(s).residences.length,2);
  assert.deepEqual(snapshot(s).residences.map(r=>r.id).sort(),['rb','rc']);
  assert.equal(canonical(s.store.read('a')),before);
  assert.equal(s.store.read('a').status,'open');
});

test('前台未满时行为完全不变',t=>{
  const s=setup(t,{maxForeground:4});
  commit(s,{changes:[state('a')],attention:patch({residency:{upsert:[residence('ra','a')],remove:[]}})});
  next(s);
  commit(s,{changes:[state('b')],attention:patch({residency:{upsert:[residence('rb','b')],remove:[]}})});
  assert.deepEqual(snapshot(s).residences.map(r=>r.id).sort(),['ra','rb']);
});

test('legacy active-task + 空 eventIds 的 State 可安全移出，正文与状态不变',t=>{
  const s=setup(t);
  commit(s,{changes:[state('old'),state('wish','想进 MC 世界',{kind:'intention'})],
    attention:patch({residency:{upsert:[legacyStateResidence('rold','old'),residence('rwish','wish')],remove:[]}})});
  const before=canonical(s.store.read('old'));
  next(s);
  commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.deepEqual(snapshot(s).residences.map(r=>r.id).sort(),['rc','rwish']);
  assert.equal(canonical(s.store.read('old')),before);
  assert.equal(s.store.read('old').status,'open');
});

test('真实的 active-task 绑定（非空 eventIds）与 Process 不被驱逐',t=>{
  const s=setup(t,{maxForeground:3});
  commit(s,{changes:[state('bound'),state('loose')],attention:patch({processes:[process('p')],
    residency:{upsert:[processResidence('rp','p'),residence('rbound','bound','state',[purpose('active-task',{eventIds:['p']})]),residence('rloose','loose')],remove:[]}})});
  next(s);
  commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.deepEqual(snapshot(s).residences.map(r=>r.id).sort(),['rbound','rc','rp']);
  assert.equal(s.store.read('bound').status,'open');
});

test('intention 不被自动移出',t=>{
  const s=setup(t,{maxForeground:1});
  commit(s,{changes:[state('wish','想进 MC 世界',{kind:'intention'})],attention:patch({residency:{upsert:[residence('rwish','wish')],remove:[]}})});
  next(s);
  assert.throws(()=>commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover),code('FOREGROUND_CAPACITY'));
  assert.deepEqual(snapshot(s).residences.map(r=>r.id),['rwish']);
  assert.equal(s.store.read('wish').status,'open');
});

test('本轮新增或更新的 State 不会被立即驱逐',t=>{
  const s=setup(t);
  commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[legacyStateResidence('ra','a'),legacyStateResidence('rb','b')],remove:[]}})});
  next(s);
  commit(s,{changes:[state('a','改了',{expectedRevision:1}),state('c')],
    attention:patch({residency:{upsert:[{id:'ra',target:{kind:'state',ref:{id:'a',revision:2}},cue:'入口 a',purposes:[purpose('active-task')]},legacyStateResidence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.deepEqual(snapshot(s).residences.map(r=>r.id).sort(),['ra','rc']);
  assert.equal(s.store.read('a').body,'改了');
});

test('没有安全候选时保持原错误，且不写入任何状态',t=>{
  const s=setup(t,{maxForeground:1});
  commit(s,{changes:[state('wish','想进 MC 世界',{kind:'intention'})],
    attention:patch({residency:{upsert:[residence('rwish','wish')],remove:[]}})});
  next(s);
  const before=snapshot(s).residences.length;
  assert.throws(()=>commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover),code('FOREGROUND_CAPACITY'));
  assert.equal(snapshot(s).residences.length,before);
  assert.equal(s.store.read('c'),null);
});

test('没有 opt-in 的普通 commit 维持原有拒绝语义',t=>{
  const s=setup(t);
  commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[residence('ra','a'),residence('rb','b')],remove:[]}})});
  next(s);
  assert.throws(()=>commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})}),code('FOREGROUND_CAPACITY'));
  assert.equal(snapshot(s).residences.length,2);
  assert.equal(s.store.read('c'),null);
});

test('恢复路径复用同一份输出，只提交一次决策且不产生 Action',t=>{
  const s=setup(t);
  commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[residence('ra','a'),residence('rb','b')],remove:[]}})});
  const before=decisions(s).length,actions=[...s.store.all('action')].length;
  next(s);
  commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.equal(decisions(s).length,before+1);
  assert.equal([...s.store.all('action')].length,actions);
  const d=decisions(s).at(-1),attempt=s.store.read(`${d.id}:attempt`);
  assert.equal(attempt.status,'adopted');
  assert.equal(attempt.output.selected,'a');
  assert.equal(JSON.stringify(attempt.output.continuity.changes),JSON.stringify(d.output.continuity.changes));
});

test('驱逐不新增 Note、Action 或额外事件记录',t=>{
  const s=setup(t);
  commit(s,{changes:[state('a'),state('b')],attention:patch({residency:{upsert:[residence('ra','a'),residence('rb','b')],remove:[]}})});
  next(s);
  const notes=[...s.store.all('note')].length,actions=[...s.store.all('action')].length,events=[...s.store.all('event')].length,decisionsBefore=decisions(s).length;
  commit(s,{changes:[state('c')],attention:patch({residency:{upsert:[residence('rc','c')],remove:[]}})},prepare(s),recover);
  assert.equal([...s.store.all('note')].length,notes);
  assert.equal([...s.store.all('action')].length,actions);
  assert.equal([...s.store.all('event')].length,events);
  assert.equal(decisions(s).length,decisionsBefore+1);
});
