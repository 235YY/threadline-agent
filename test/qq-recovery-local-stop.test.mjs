import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {ContinuityStore} from '../src/store.mjs';import {ContinuitySession} from '../src/continuity-session.mjs';
import {verifiedModelInput} from '../src/cognition.mjs';
import {withTypedStateContract} from '../tools/brain-service/typed-state-contract.mjs';
function fixture(error='MODEL_ERROR'){
 const store=new ContinuityStore(':memory:',{clock:()=>1000});new ContinuitySession({store,subjectId:'s'});
 const packet={packetId:'synthetic-local-stop',payload:{continuity:{subject:{id:'s',revision:1}}}},id='affect-turn:'+packet.packetId;
 store.execute({requestId:'prepare',commands:[{op:'affect_turn',id,expectedRevision:0,value:{subject:'s',status:'prepared',packet,rawOutput:null}}]});
 store.execute({requestId:'dispatch',commands:[{op:'affect_turn',id,expectedRevision:1,status:'dispatched'}]});
 store.execute({requestId:'uncertain',commands:[{op:'affect_turn',id,expectedRevision:2,status:'uncertain',error,transportInvoked:null}]});
 const resolution={reason:'LOCAL_GATE_NOT_DISPATCHED',requestId:null,noProviderCall:true,ledgerStatus:'not-registered',evidenceHash:'a'.repeat(64),sourceHash:'b'.repeat(64),gateHash:'c'.repeat(64),manifestHash:'d'.repeat(64),blockedAt:999};
 return {store,id,resolution,close:r=>store.execute({requestId:'reviewed-close',commands:[{op:'affect_turn',id,expectedRevision:3,status:'closed-incomplete',resolution:r}]})};
}
test('reviewed local gate needs all proof fields and preserves the original uncertain version',()=>{
 const f=fixture();try{const bad={...f.resolution};delete bad.sourceHash;assert.throws(()=>f.close(bad),{code:'AFFECT_RESOLUTION'});f.close(f.resolution);assert.equal(f.store.read(f.id).status,'closed-incomplete');assert.equal(f.store.read(f.id,3).status,'uncertain');assert.equal(f.store.read(f.id).error,'MODEL_ERROR');}finally{f.store.close();}
});
test('a later stop marker cannot establish a prior unsent boundary',()=>{const f=fixture();try{assert.throws(()=>f.close({...f.resolution,blockedAt:1001}),{code:'AFFECT_RESOLUTION'});}finally{f.store.close();}});
test('real provider UNKNOWN cannot use the local-gate closure',()=>{const f=fixture('UNCERTAIN_REQUEST');try{assert.throws(()=>f.close(f.resolution),{code:'AFFECT_RESOLUTION'});assert.equal(f.store.read(f.id).status,'uncertain');}finally{f.store.close();}});
test('typed interface instructions reach the actual sealed model request without granting unread states',()=>{
 const store=new ContinuityStore(':memory:');try{
 store.execute({requestId:'seed',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'current',label:'now'}},{op:'append_event',id:'e',body:'offline',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:1000,source:{system:'fixture',key:'e'}}]});
 const session=withTypedStateContract(args=>new ContinuitySession(args))({store,subjectId:'s',attention:true}),p=session.prepare({workspace:{id:'w',revision:1},currentEvent:{id:'e',revision:1},mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},budgetBytes:131072});
 const actual=verifiedModelInput(p);assert.match(actual.messages[0].content,/不同对象，即使 ID 相同也不能互换/);assert.equal(actual.bytes,p.bytes);assert.deepEqual(p.payload.continuity.foreground,[]);assert.deepEqual(p.payload.continuity.recalled,[]);
 }finally{store.close();}
});

test('reviewed legacy host-packet rejection requires complete frozen-source and ledger evidence',()=>{const f=fixture('PACKET_CHANGED');try{const resolution={reason:'HOST_INPUT_NOT_DISPATCHED',validationError:'PACKET_CHANGED',requestId:null,noProviderCall:true,ledgerStatus:'not-registered',sourceHash:'a'.repeat(64),manifestHash:'b'.repeat(64),ledgerHash:'c'.repeat(64),evidenceHash:'d'.repeat(64),sourceFrozenAt:999};for(const key of ['sourceHash','manifestHash','ledgerHash','evidenceHash']){const bad={...resolution};delete bad[key];assert.throws(()=>f.close(bad),{code:'AFFECT_RESOLUTION'});}assert.throws(()=>f.close({...resolution,sourceFrozenAt:1001}),{code:'AFFECT_RESOLUTION'});assert.throws(()=>f.close({...resolution,ledgerStatus:'uncertain'}),{code:'AFFECT_RESOLUTION'});f.close(resolution);assert.equal(f.store.read(f.id).status,'closed-incomplete');assert.equal(f.store.read(f.id,3).status,'uncertain');assert.equal([...f.store.all('decision')].length,0);}finally{f.store.close();}});
