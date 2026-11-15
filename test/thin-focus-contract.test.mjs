import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openFocusFixture,SUPPLEMENT_CASES} from '../experiments/focus-study/fixture.mjs';
import {wirePacket,verifiedWire,expandOutput,declaredEvidence} from '../experiments/automated-study/protocol.mjs';
import {checkCaseGate} from '../experiments/bounded-study.mjs';

test('焦点薄接口只有一个输出外壳；保留输入continuity路径和完整语义限制',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const p=f.prepare(),w=wirePacket(p.packet,'compact-focus');verifiedWire(w);
  assert.equal(w.stage,'study-compact-focus-v2');assert.match(w.instruction,/attention是顶层可选字段/);
  assert.doesNotMatch(w.instruction,/continuity在原四字段以外还必须有attention/);
  assert.doesNotMatch(w.instruction,/旧residency.add\/remove必须空/);
  for(const s of ['continuity.attention.frame','continuity.mind','world=actual/possible','不自动暂停父过程','owners','不因切焦点而消除感受'])assert.ok(w.instruction.includes(s),s);
  assert.deepEqual(w.basePacket.payload,p.packet.payload);assert.ok(w.bytes<=w.budgetBytes);
 }finally{f.store.close();}
});
test('顶层attention能够提交；旧外壳仍拒绝，不静默翻译格式错误',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const p=f.prepare(),wire=wirePacket(p.packet,'compact-focus'),attention={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[],focus:{select:[]}};
  const out={packetId:wire.packetId,choice:{kind:'continue',payload:{}},attention,used:[{ref:{id:'incoming-0',revision:1},aspect:'experience',effect:'context'}]};
  assert.equal(declaredEvidence(wire,JSON.stringify(out)).observationUses.length,1);
  assert.throws(()=>expandOutput(wire,JSON.stringify({...out,attention:undefined,continuity:{attention}})),{code:'OUTPUT_SHAPE'});
  const d=f.commit({...p,wire},JSON.stringify(out),'thin-focus-legal');assert.deepEqual(d.output.continuity.attention.focus,{select:[]});
  assert.equal(f.snapshot().states.length,4);assert.deepEqual(f.snapshot().requiredByProjection,[]);
 }finally{f.store.close();}
});
test('synthetic sealed wire remains verifiable without mutating its serialized input',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const p=f.prepare(),wire=wirePacket(p.packet,'compact-focus'),before=JSON.stringify(wire),reopened=JSON.parse(before);
  verifiedWire(reopened);assert.equal(JSON.stringify(reopened),before);assert.deepEqual(reopened.basePacket.payload,p.packet.payload);
 }finally{f.store.close();}
});
test('新profile不放宽来源、版本与用途权限',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const p=f.prepare(),w=wirePacket(p.packet,'compact-focus'),raw=(id,revision=1)=>JSON.stringify({packetId:w.packetId,choice:{kind:'continue',payload:{}},used:[{ref:{id,revision},aspect:'experience',effect:'context'}]});
  assert.throws(()=>expandOutput(w,raw('incoming-0',2)),{code:'UNDELIVERED_REFERENCE'});
  assert.throws(()=>expandOutput(w,raw('fabricated')),{code:'UNDELIVERED_REFERENCE'});
 }finally{f.store.close();}
});
test('注册门槛由驱动强制：首次允许，旧结果失败/提交不足均阻止下例',()=>{
 const gate={minCommitted:2};assert.doesNotThrow(()=>checkCaseGate([],gate));
 assert.throws(()=>checkCaseGate([{rounds:[{},{}],failure:{errorCode:'OUTPUT_SHAPE'}}],gate),{code:'CASE_GATE'});
 assert.throws(()=>checkCaseGate([{rounds:[{}],failure:null}],gate),{code:'CASE_GATE'});
 assert.doesNotThrow(()=>checkCaseGate([{rounds:[{},{}],failure:null}],gate));
 assert.doesNotThrow(()=>checkCaseGate([{rounds:[],failure:{}}],null));
});
