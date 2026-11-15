import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {buildReplyPayload} from '../tools/qq-connect/bridge-payload.mjs';
import {threadUnits} from '../src/task-threads.mjs';

const attention={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]};
function decide(packet){
  return JSON.stringify({packetId:packet.packetId,options:[{id:'reply',kind:'respond',payload:{text:'fake full-chain reply'}}],selected:'reply',
    summary:'rc1 fake bridge chain',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,
      observationDisposition:'handled',attention}});
}
test('RC1 fake OneBot payload → /v1/reply → event.threadId → fake adapter → receipt',async t=>{
  const sent=[];
  const service=await startBrainService({port:0,storePath:':memory:',identity:'rc1 test',decide,global:true,heartbeatMs:0,
    adapter:{send:async({scene,text})=>{sent.push({scene,text});return {delivered:true,scene,text};}}});
  t.after(async()=>{await new Promise(resolve=>service.server.close(resolve));service.close();});
  const event={message_type:'private',user_id:424242,message_id:'m-1',time:1700000000,
    sender:{nickname:'测试者'},message:[{type:'text',data:{text:'你好'}}]};
  const payload=buildReplyPayload(event,{selfId:999,threadId:'task-alpha'});
  payload.execute=true;
  assert.equal(payload.threadId,'task-alpha');
  const response=await fetch(`${service.url}/v1/reply`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const body=await response.json();
  assert.equal(response.status,200);
  const item=body.outbox.find(x=>x.kind==='respond');
  assert.ok(item?.response);
  const delivered=await fetch(`${service.url}/v1/response/delivered`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({response:item.response,outcome:'sent',body:'fake full-chain receipt'})});
  assert.equal(delivered.status,200);
  const eventRecord=[...service.store.all('event')].find(x=>x.origin==='reported'&&x.source?.key?.includes('m-1'));
  assert.ok(eventRecord);
  assert.equal(eventRecord.threadId,'task-alpha');
  const history=threadUnits({store:service.store,threadId:'task-alpha',limit:30});
  assert.equal(history.units.length,1);
  assert.equal(history.units[0].id,eventRecord.id);
  assert.equal(eventRecord.actor,'person:qq:424242');
  assert.equal(sent.length,1);
  const responseRecord=service.store.read(item.response.id);
  assert.equal(responseRecord.status,'sent');
});
