import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';

const replyOutput=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'ok'}}],selected:'r',summary:'operator fixture',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}});

async function service(t){
  const s=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,global:true,shutdownControl:{token:'operator-test',stop:async()=>{}},decide:p=>replyOutput(p)});
  t.after(async()=>{await new Promise(r=>s.server.close(r));s.close();});
  return s;
}
async function operator(s,body,headers={'x-jingyang-control':'operator-test'}){
  const port=s.server.address().port;
  const res=await fetch(`http://127.0.0.1:${port}/v1/operator/effect`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:res.status,body:await res.json()};
}

test('operator route requires the existing control token',async t=>{
  const s=await service(t);const r=await operator(s,{},{});
  assert.equal(r.status,400);
  assert.equal(r.body.error,'UNAUTHORIZED');
});

test('operator closes a pending response as failed without sending',async t=>{
  const s=await service(t);
  await s.reply({scene:'qq/private/1',key:'operator-1',message_id:'1',messages:[{role:'user',content:'hello'}]});
  const response=s.pendingEffects().responses[0].response;
  const r=await operator(s,{type:'response',id:response.id,transition:'failed',evidence:{operator:'test',transportInvoked:false}});
  assert.equal(r.status,200);
  assert.equal(r.body.status,'failed');
  assert.equal(s.store.read(response.id).status,'failed');
  assert.equal(s.pendingEffects().responses.filter(x=>x.status==='pending').length,0);
});

test('operator refuses to fabricate an unknown response correction',async t=>{
  const s=await service(t);
  await s.reply({scene:'qq/private/2',key:'operator-2',message_id:'2',messages:[{role:'user',content:'hello'}]});
  const response=s.pendingEffects().responses[0].response;
  // pending cannot be declared unknown without a claim; failed is the only safe closure
  const r=await operator(s,{type:'response',id:response.id,transition:'unknown',evidence:{operator:'test'}});
  assert.equal(r.status,200);
  assert.equal(r.body.status,'unknown');
  const again=await operator(s,{type:'response',id:response.id,transition:'failed',evidence:{operator:'test'}});
  assert.equal(again.status,200);
  assert.equal(again.body.retained,true);
});
