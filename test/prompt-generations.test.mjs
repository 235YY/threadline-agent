import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {canonical,digest} from '../src/contracts.mjs';
import {verifiedModelInput,sealedWithGeneration} from '../src/cognition.mjs';
import {wirePacket,verifiedWire,WIRE_PROMPTS} from '../experiments/automated-study/protocol.mjs';
import {maintenancePacket,verifyMaintenancePacket,maintenancePolicy,MAINTENANCE_PROMPTS} from '../src/maintenance-protocol.mjs';
import {ARCHIVED_PROMPT_GENERATIONS} from '../src/prompt-generations.mjs';
import {openFocusFixture,SUPPLEMENT_CASES} from '../experiments/focus-study/fixture.mjs';

const OLD='r006';
// Re-seal a cognition/wire packet around a forged instruction so that only the instruction is wrong.
const forge=(p,instruction,payload,idFields)=>{
 const packetId=digest({...idFields,instruction});
 const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,...payload})}];
 return {...structuredClone(p),packetId,instruction,messages,bytes:Buffer.byteLength(canonical(messages),'utf8')};
};

test('archived generations are complete snapshots: every file they had still exists in the current set',()=>{
 const names=d=>readdirSync(new URL(d,import.meta.url)).filter(n=>n.endsWith('.zh.md')).sort();
 const current=new Set(names('../prompts/'));
 for(const g of ARCHIVED_PROMPT_GENERATIONS){const old=names(`../prompts/archive/${g}/`);assert.ok(old.length>20,g);for(const f of old)assert.ok(current.has(f),`${g}/${f}`);}
});

test('cognition: a packet sealed by the archived generation verifies; a forged instruction does not',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const current=f.prepare().packet,old=sealedWithGeneration(current,OLD);
  assert.notEqual(old.instruction,current.instruction,'fixture must exercise a changed prompt');
  assert.match(old.instruction,/每项必须含id、expectedRevision、nature/);
  assert.doesNotThrow(()=>verifiedModelInput(current));assert.doesNotThrow(()=>verifiedModelInput(old));
  const data=JSON.parse(old.messages[1].content);delete data.packetId;
  const forged=forge(old,old.instruction+'\n额外指令。',data,{stage:old.stage,payload:data});
  assert.throws(()=>verifiedModelInput(forged),{code:'PACKET_CHANGED'});
  const mixed={...structuredClone(old),instruction:current.instruction};
  assert.throws(()=>verifiedModelInput(mixed),{code:'PACKET_CHANGED'});
 }finally{f.store.close();}
});

test('compact wire: archived generation verifies; tampering is rejected',()=>{
 const f=openFocusFixture(':memory:',SUPPLEMENT_CASES[0]);try{
  const base=f.prepare().packet,current=wirePacket(base,'compact-focus'),old=wirePacket(base,'compact-focus',WIRE_PROMPTS.byName(OLD));
  assert.notEqual(old.instruction,current.instruction);
  assert.doesNotThrow(()=>verifiedWire(current));assert.doesNotThrow(()=>verifiedWire(old));
  const forged=forge(old,old.instruction+'x',old.basePacket.payload,{stage:old.stage,basePacketId:base.packetId,payload:old.basePacket.payload});
  assert.throws(()=>verifiedWire(forged),{code:'PACKET_CHANGED'});
 }finally{f.store.close();}
});

test('maintenance: whole prompt is versioned; archived packet verifies, tampered one is rejected',()=>{
 const policy=maintenancePolicy(),payload={kind:'synthetic',continuity:{mind:{format:'jingyang-mind-view-v1'},attention:{focusSupport:{enabled:true}}}};
 const old=maintenancePacket(payload,policy,MAINTENANCE_PROMPTS.byName(OLD)),current=maintenancePacket(payload,policy);
 assert.notEqual(old.instruction,current.instruction);
 assert.doesNotThrow(()=>verifyMaintenancePacket(old,policy));assert.doesNotThrow(()=>verifyMaintenancePacket(current,policy));
 const forged={...structuredClone(old),instruction:old.instruction+'x'};
 assert.throws(()=>verifyMaintenancePacket(forged,policy),{code:'PACKET_CHANGED'});
 assert.throws(()=>verifyMaintenancePacket({...structuredClone(old),payload:{...payload,kind:'other'}},policy),{code:'PACKET_CHANGED'});
});

test('archived r006 prompts match the operation boundary text previously inlined in cognition',()=>{
 const old=readFileSync(new URL('../prompts/archive/r006/operation-boundary.zh.md',import.meta.url),'utf8');
 assert.match(old,/新状态选择新的独立id且expectedRevision=0/);
});
