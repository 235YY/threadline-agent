import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ContinuityStore} from '../src/store.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId} from '../src/attention.mjs';
import {intentPacket} from '../src/intent-protocol.mjs';
import {canonical} from '../src/contracts.mjs';
import {memory,put,event,frame,ref} from './helpers.mjs';

const policy={maxReads:4,maxHits:4};
const purpose=kind=>({kind,eventIds:[],questionId:null,appliesTo:null});
const residence=(id,target,kind='state',purposes=[purpose('self-directed')])=>({id,target:{kind,ref:{id:target,revision:1}},cue:`入口 ${target}`,purposes});
const state=(id,fields={})=>({id,expectedRevision:0,kind:'feeling',body:`状态 ${id}`,status:'open',nature:'self-report',...fields});
function setup(t,{maxForeground=1,requestJournal=null}={}){
  const store=memory(t).store;
  const session=new ContinuitySession({store,subjectId:'s',attention:true,maxForeground,requestJournal});
  const [o,w]=put(store,'initial:entries',event('e1'),frame());
  return {store,session,o,w,seq:0};
}
function prepare(s,extra={}){return s.session.prepare({currentEvent:ref(s.o),workspace:ref(s.w),localLookupPolicy:policy,budgetBytes:65536,...extra});}
function out(packet,{changes=[],attention}={}){
  const keep={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[],followups:[]};
  return {packetId:packet.packetId,options:[{id:'a',kind:'wait',payload:{}}],selected:'a',summary:'手工结构测试',used:[],
    continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention??keep}};
}
function commit(s,fields={}){
  const packet=prepare(s),id=`d${++s.seq}`;
  return s.session.commit({packet,output:out(packet,fields),decisionId:id,requestId:`commit:${id}`});
}
function next(s,id=`e${++s.seq+1}`){s.o=put(s.store,`append:${id}`,event(id))[0];return s;}

test('入口矩阵在 policy 层唯一解析，且 turn-driver 按调用路径映射六类 decisionKind',()=>{
  const source=readFileSync(new URL('../src/turn-driver.mjs',import.meta.url),'utf8');
  assert.equal(source.includes('allowsForegroundRecovery({decisionKind:'),true);
  assert.equal(source.includes("if(context?.kind==='autonomy')return 'autonomy'"),true);
  assert.equal(source.includes("if(context?.kind==='reflection')return 'reflection'"),true);
  assert.equal(source.includes("if(packet?.payload?.task)return 'task'"),true);
  assert.equal(source.includes("current?.source?.system==='agent-runtime')return 'agent'"),true);
  assert.equal(source.includes("return 'foreground'"),true);
  assert.equal(source.includes('foregroundRecovery=false'),false,'per-driver foregroundRecovery option must be gone');
});

test('intent 模型可见容量只有一句提示，不含 used/max',t=>{
  const s=setup(t,{maxForeground:1});
  commit(s,{changes:[state('a')],attention:{processes:[],relations:[],residency:{upsert:[residence('ra','a')],remove:[]},questions:[],followups:[]}});
  next(s);
  const base=prepare(s,{intentProtocol:true});
  const packet=intentPacket(base);
  const instruction=packet.messages[0].content,view=JSON.parse(packet.messages[1].content).view;
  assert.equal(instruction.includes('注意力工作区已经满了。外面还有一件事在等你。先看看有没有可以暂时放下的旧事，再处理它。'),true);
  assert.equal(/used\s*\/\s*max/.test(instruction),false);
  assert.equal(instruction.includes('maxForeground'),false);
  const visible=canonical(view.attention);
  assert.equal(visible.includes('"used"'),false);
  assert.equal(visible.includes('"max"'),false);
  assert.equal(view.attention.residences.length,1,'addressable residences remain visible without occupancy numbers');
});

test('容量拒绝保持 fail-closed：源 deferred，不产生 Decision，不 quarantine/handled',t=>{
  const s=setup(t,{maxForeground:1});
  commit(s,{changes:[state('a')],attention:{processes:[],relations:[],residency:{upsert:[residence('ra','a')],remove:[]},questions:[],followups:[]}});
  const decisions=[...s.store.all('decision')].length;
  next(s);
  const packet=prepare(s);
  assert.throws(()=>s.session.commit({packet,output:out(packet,{changes:[state('b')],attention:{processes:[],relations:[],residency:{upsert:[residence('rb','b')],remove:[]},questions:[],followups:[]}}),decisionId:'overflow',requestId:'commit:overflow'}),error=>error.code==='FOREGROUND_CAPACITY');
  assert.equal([...s.store.all('decision')].length,decisions,'capacity failure must not create a decision');
  assert.equal(s.store.subjectObservation('s',s.o.id).status,'deferred','source is deferred, not handled/quarantined');
});

test('容量类错误经过共享 commit 管道不写 journal rejected、不 quarantine（affect-on 同管道）',t=>{
  const validations=[];
  const journal={packetRequest:()=>({id:'fake-settled-turn',status:'settled',validation:null}),
    recordValidation:(packetId,validation)=>{validations.push({packetId,validation});}};
  const s=setup(t,{maxForeground:1,requestJournal:journal});
  commit(s,{changes:[state('a')],attention:{processes:[],relations:[],residency:{upsert:[residence('ra','a')],remove:[]},questions:[],followups:[]}});
  const acceptedBefore=validations.filter(v=>v.validation?.status==='accepted').length;
  next(s);
  const packet=prepare(s);
  assert.throws(()=>s.session.commit({packet,output:out(packet,{changes:[state('b')],attention:{processes:[],relations:[],residency:{upsert:[residence('rb','b')],remove:[]},questions:[],followups:[]}}),decisionId:'overflow',requestId:'commit:overflow'}),error=>error.code==='FOREGROUND_CAPACITY');
  assert.equal(validations.some(v=>v.validation?.status==='rejected'),false,'capacity must never be recorded as a journal model rejection');
  assert.equal(validations.filter(v=>v.validation?.status==='accepted').length,acceptedBefore,'failed capacity turn must not be adopted');
  assert.equal(s.store.subjectObservation('s',s.o.id).status,'deferred','source remains deferred, not handled/quarantined');
});

test('policy/measure 无持久副作用：无新记录类型，host snapshot 与模型 view 分离',async t=>{
  const types=['extension_record','affect_turn','attention_frame','subject'];
  const store=new ContinuityStore(':memory:',{clock:()=>2000});
  t.after(()=>store.close());
  const before=Object.fromEntries(types.map(type=>[type,[...store.all(type)].length]));
  const {createAttentionCapacityPolicy,capacityLimits}=await import('../src/attention.mjs');
  const p=createAttentionCapacityPolicy();
  const frameLike={subject:'s',processes:[],relations:[],residences:[],questions:[],followups:[]};
  const host=p.snapshot(frameLike,capacityLimits(4));
  assert.deepEqual(host,{used:0,max:4,full:false,slots:{foreground:{used:0,max:4},processes:{used:0,max:128},relations:{used:0,max:256},questions:{used:0,max:64},followups:{used:0,max:32},deferrals:{used:0,max:32}}});
  const after=Object.fromEntries(types.map(type=>[type,[...store.all(type)].length]));
  assert.deepEqual(after,before);
  assert.equal(store.read(attentionId('s')),null);
});
