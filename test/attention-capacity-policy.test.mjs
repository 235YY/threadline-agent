import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {
  ATTENTION_CAPACITY_LIMITS,ATTENTION_CAPACITY_HINT,ATTENTION_CAPACITY_POLICY_FORMAT,ATTENTION_DECISION_KINDS,
  ATTENTION_CAPACITY_CODES,capacityLimits,measureAttention,createAttentionCapacityPolicy,normalizeAttentionCapacityPolicy,
  isAttentionCapacityError,DEFAULT_ATTENTION_CAPACITY_POLICY,emptyAttention,attentionView,advanceAttention
} from '../src/attention.mjs';
import {canonical} from '../src/contracts.mjs';

// Synthetic frame/read only: this file tests host capacity mechanics, not model psychology.
const state=(id,kind='feeling')=>({id,revision:1,type:'personal_state',subject:'s',kind,body:`状态 ${id}`,status:'open',nature:'self-report'});
function frameWith(residences,{processes=[],relations=[],questions=[],followups=[],deferrals=[]}={}){
  return {...emptyAttention('s'),residences,processes,relations,questions,followups,deferrals};
}
const residence=(id,target,{kind='state',purposes=[{kind:'self-directed',eventIds:[]}]}={})=>({id,target:{kind,ref:{id:target,revision:1}},cue:`入口 ${target}`,purposes});
const readMap=records=>(id,revision)=>records[id]??null;

test('limits 单源：ATTENTION_CAPACITY_LIMITS 冻结且 capacityLimits 只从 subject 取 foreground',()=>{
  assert.ok(Object.isFrozen(ATTENTION_CAPACITY_LIMITS));
  assert.deepEqual({...ATTENTION_CAPACITY_LIMITS},{processes:128,relations:256,questions:64,followups:32,questionAttempts:16,deferrals:32,residenceUpsert:16,restoration:16});
  assert.equal(capacityLimits(24).foreground,24);
  assert.equal(capacityLimits({maxForeground:5}).foreground,5);
  assert.equal(capacityLimits().foreground,8);
  assert.ok(Object.isFrozen(capacityLimits(8)));
  assert.throws(()=>capacityLimits(0),error=>error.code==='STATE_LIMIT');
  assert.throws(()=>capacityLimits(33),error=>error.code==='STATE_LIMIT');
});

test('measureAttention 是 host-only 单一 measure：used/max/full/slots 与 policy 一致',()=>{
  const frame=frameWith([residence('r1','a'),residence('r2','b')],{
    processes:[{id:'p1',status:'active'},{id:'p2',status:'completed'}],
    relations:[{id:'g1'}],questions:[{id:'q1'}],followups:[{id:'f1'}],
    deferrals:[{id:'d1',status:'pending'},{id:'d2',status:'restored'}]
  });
  const measured=measureAttention(frame,2);
  assert.deepEqual(measured,{used:2,max:2,full:true,slots:{
    foreground:{used:2,max:2},processes:{used:1,max:128},relations:{used:1,max:256},
    questions:{used:1,max:64},followups:{used:1,max:32},deferrals:{used:1,max:32}
  }});
  const policy=createAttentionCapacityPolicy();
  assert.deepEqual(policy.measure(frame,2),measured);
  assert.deepEqual(policy.snapshot(frame,2),measured);
});

test('policy 冻结 shape/resolver：六类 decisionKind，只有 foreground 允许回收',()=>{
  assert.deepEqual([...ATTENTION_DECISION_KINDS],['foreground','autonomy','reflection','task','agent']);
  const policy=createAttentionCapacityPolicy();
  assert.ok(Object.isFrozen(policy));
  assert.equal(policy.format,ATTENTION_CAPACITY_POLICY_FORMAT);
  assert.equal(policy.hint,ATTENTION_CAPACITY_HINT);
  assert.equal(ATTENTION_CAPACITY_HINT,'注意力工作区已经满了。外面还有一件事在等你。先看看有没有可以暂时放下的旧事，再处理它。');
  for(const kind of ATTENTION_DECISION_KINDS){
    assert.equal(policy.resolve({decisionKind:kind}),kind);
    assert.equal(policy.allowsForegroundRecovery({decisionKind:kind}),kind==='foreground');
  }
  assert.equal(policy.resolve({}),'reflection','unknown decision context must be fail-closed background');
  const custom=createAttentionCapacityPolicy({resolver:()=> 'autonomy'});
  assert.equal(custom.allowsForegroundRecovery({decisionKind:'foreground'}),false);
  const broken=createAttentionCapacityPolicy({resolver:()=> 'other'});
  assert.throws(()=>broken.resolve({decisionKind:'foreground'}),error=>error.code==='ATTENTION_POLICY_SHAPE');
  assert.equal(normalizeAttentionCapacityPolicy(null),DEFAULT_ATTENTION_CAPACITY_POLICY);
  assert.equal(normalizeAttentionCapacityPolicy(policy),policy);
  assert.throws(()=>normalizeAttentionCapacityPolicy({}),error=>error.code==='ATTENTION_POLICY_SHAPE');
});

test('错误分类统一：host 容量三类；RESIDENCE_UPSERT_CAPACITY/ATTENTION_LIMIT 是语义形状错误',()=>{
  assert.deepEqual([...ATTENTION_CAPACITY_CODES],['FOREGROUND_CAPACITY','ATTENTION_CAPACITY','DEFERRAL_CAPACITY']);
  assert.equal(isAttentionCapacityError('FOREGROUND_CAPACITY'),true);
  assert.equal(isAttentionCapacityError('ATTENTION_CAPACITY'),true);
  assert.equal(isAttentionCapacityError('DEFERRAL_CAPACITY'),true);
  assert.equal(isAttentionCapacityError('RESIDENCE_UPSERT_CAPACITY'),false,'host capacity gate excludes typed output/commit-limit refusals');
  assert.equal(isAttentionCapacityError('ATTENTION_LIMIT'),false,'malformed/oversized inputs are shape errors, not capacity deferrals');
  assert.equal(isAttentionCapacityError('STATE_CONFLICT'),false);
  assert.equal(createAttentionCapacityPolicy().isCapacityError('RESIDENCE_UPSERT_CAPACITY'),false,'policy gate must not treat the commit limit as host capacity');
});

test('模型可见 capacity 只有一句自然语言，不暴露 used/max',()=>{
  const frame=frameWith([residence('r1','a')]);
  const view=attentionView(frame,{read:readMap({a:state('a')}),currentEvent:null,maxForeground:1});
  assert.equal(view.metadata.capacityHint,ATTENTION_CAPACITY_HINT);
  const visible=JSON.stringify(view.metadata);
  assert.equal(visible.includes('"used"'),false);
  assert.equal(visible.includes('"max"'),false);
  const roomy=attentionView(frame,{read:readMap({a:state('a')}),currentEvent:null,maxForeground:2});
  assert.equal(Object.hasOwn(roomy.metadata,'capacityHint'),false);
});

test('唯一写 seam：只有 store 的 update_attention 调用 advanceAttention（attention.mjs 仅定义）',()=>{
  const src=new URL('../src/',import.meta.url);
  const calls=[];
  for(const file of readdirSync(src).filter(name=>name.endsWith('.mjs')&&name!=='attention.mjs')){
    const text=readFileSync(new URL(file,src),'utf8');
    const count=(text.match(/advanceAttention\s*\(/g)??[]).length;
    if(count)calls.push({file,count});
  }
  assert.deepEqual(calls,[{file:'store.mjs',count:1}]);
});

test('回收有界且保护集合：只移最旧普通 state，task 绑定/intention 不动，诊断含 evicted ids',()=>{
  const records={old:state('old'),task:state('task'),wish:state('wish','intention')};
  const frame=frameWith([
    residence('r-old','old'),
    residence('r-task','task',{purposes:[{kind:'active-task',eventIds:['e1']}]}),
    residence('r-wish','wish')
  ]);
  const diagnostics=[];
  const delta={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[],followups:[]};
  const next=advanceAttention(frame,delta,{read:readMap(records),at:1,maxForeground:2,foregroundRecovery:true,
    memoryRefs:[],processRefs:[],relationRefs:[],questionRefs:[],residenceIds:['r-old','r-task','r-wish'],stateRefs:[],
    observations:[],onCapacityEviction:ids=>diagnostics.push([...ids])});
  assert.deepEqual(next.residences.map(r=>r.id),['r-task','r-wish']);
  assert.deepEqual(diagnostics,[['r-old']]);
  assert.throws(()=>advanceAttention(frame,delta,{read:readMap(records),at:1,maxForeground:2,foregroundRecovery:false,
    memoryRefs:[],processRefs:[],relationRefs:[],questionRefs:[],residenceIds:['r-old','r-task','r-wish'],stateRefs:[],
    observations:[]}),error=>error.code==='FOREGROUND_CAPACITY');
});
