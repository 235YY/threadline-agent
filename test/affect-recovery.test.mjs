import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
const T=1794400000000;
test('only reviewed settled incomplete turn can close; old source cannot retry and new input can proceed',async()=>{
 const store=new ContinuityStore(':memory:',{clock:()=>T});
 try{
  store.execute({requestId:'world',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成'}}]});
  const event=id=>{store.execute({requestId:id,commands:[{op:'append_event',id,body:'离线合成消息',origin:'reported',actor:'fixture',scene:'synthetic',occurredAt:T,source:{system:'fixture',key:id}}]});return {id,revision:1};};
  const session=new AffectSession({store,subjectId:'s',clock:()=>T}),args=currentEvent=>({currentEvent,workspace:{id:'w',revision:1},identity:'合成主体',now:T,budgetBytes:90000,mind:true,unified:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[]});
  const old=event('old'),packet=await session.prepare(args(old));
  await assert.rejects(session.invoke(packet,()=>{throw Object.assign(Error('incomplete'),{code:'MODEL_INCOMPLETE'});}),{code:'MODEL_INCOMPLETE'});
  const turn=[...store.all('affect_turn')][0],command={op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'closed-incomplete'};
  assert.throws(()=>store.execute({requestId:'bad-close',commands:[command]}),{code:'AFFECT_RESOLUTION'});
  store.execute({requestId:'reviewed-close',commands:[{...command,resolution:{requestId:'turn:'+packet.packetId,ledgerStatus:'settled',actualMicros:123,evidenceHash:'a'.repeat(64)}}]});
  assert.equal(store.read(turn.id).status,'closed-incomplete');assert.equal([...store.all('decision')].length,0);
  await assert.rejects(session.prepare(args(old)),{code:'AFFECT_SOURCE_STOPPED'});
  assert.ok((await session.prepare(args(event('new')))).payload.continuity.motivation);
 }finally{store.close();}
});
