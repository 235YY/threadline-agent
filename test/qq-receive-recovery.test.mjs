import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MessageReceiver} from '../tools/qq-connect/receive.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {buildReplyPayload} from '../tools/qq-connect/bridge-payload.mjs';

function fixture(t,extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jy-receive-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('jy-receive-'));fs.rmSync(dir,{recursive:true,force:true});});
  const options={stateFile:path.join(dir,'receive.json'),selfId:9,since:1700000000000,now:()=>1700000060000,...extra};
  return {options,receiver:new MessageReceiver(options)};
}
const event=(id=1,time=1700000010,other={})=>({post_type:'message',message_type:'private',user_id:7,message_id:id,time,sender:{nickname:'合成测试用户'},message:[{type:'text',data:{text:'合成接收验证'}}],...other});
const chat={kind:'private',id:'7'};

test('dropped QQ push is recovered by history and delivered through normal brain/claim/receipt',async t=>{
  const {receiver}=fixture(t),sent=[];
  const service=await startBrainService({port:0,storePath:':memory:',global:true,heartbeatMs:0,identity:'synthetic receive test',
    adapter:{send:async({scene,text})=>{sent.push({scene,text});return {delivered:true};}},
    decide:p=>JSON.stringify({packetId:p.packetId,options:[{id:'reply',kind:'respond',payload:{text:'合成回复'}}],selected:'reply',summary:'合成接收',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled'}})});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  const deliver=async e=>{const payload=buildReplyPayload(e,{selfId:9});payload.execute=true;const r=await fetch(service.url+'/v1/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const body=await r.json();assert.equal(body.ok,true);return body;};
  const enqueue=(e,source)=>receiver.accept(e,{source,deliver});
  const first=await receiver.reconcile(chat,{fetchHistory:async()=>[event()],enqueue});assert.equal(first.recovered,1);
  await enqueue(event(),'push');await receiver.reconcile(chat,{fetchHistory:async()=>[event()],enqueue});
  assert.equal(sent.length,1);assert.equal(sent[0].scene,'qq/private/7');
  assert.equal([...service.store.all('response')][0].status,'sent');
  assert.ok(service.store.read('obs:private:7:1'));
});

test('push and history share durable identities across restart; same-second messages remain distinct',async t=>{
  const {receiver,options}=fixture(t);const delivered=[];const deliver=async e=>{delivered.push(e.message_id);return {ok:true};};
  await receiver.accept(event(1),{deliver});const reopened=new MessageReceiver(options);
  await reopened.reconcile(chat,{fetchHistory:async()=>[event(2),event(1)],enqueue:(e,source)=>reopened.accept(e,{source,deliver})});
  assert.deepEqual(delivered,[1,2]);
});

test('concurrent duplicate calls reserve the identity before awaiting delivery',async t=>{
  const {receiver}=fixture(t);let finish,calls=0;const pending=receiver.accept(event(),{deliver:()=>{calls++;return new Promise(r=>{finish=r;});}});
  const dup=await receiver.accept(event(),{deliver:async()=>{calls++;}});assert.equal(dup.duplicate,true);assert.equal(dup.status,'started');finish({ok:true});await pending;assert.equal(calls,1);
});

test('pre-delivery persistence failure sends nothing and poisons further delivery',async t=>{
  let saves=0,calls=0;const {receiver}=fixture(t,{save:()=>{if(++saves>1)throw Object.assign(Error('disk fault'),{code:'EIO'});}});
  await assert.rejects(receiver.accept(event(),{deliver:async()=>{calls++;}}),{code:'EIO'});
  await assert.rejects(receiver.accept(event(2),{deliver:async()=>{calls++;}}),{code:'RECEIVE_STATE_UNAVAILABLE'});assert.equal(calls,0);
});

test('interruption or unknown brain result never automatically replays that identity',async t=>{
  const {receiver,options}=fixture(t);let calls=0;
  await assert.rejects(receiver.accept(event(),{deliver:async()=>{calls++;throw Object.assign(Error('no acknowledgement'),{code:'NETWORK'});}}));
  const reopened=new MessageReceiver(options);const dup=await reopened.accept(event(),{deliver:async()=>{calls++;}});
  assert.equal(dup.status,'unconfirmed');assert.equal(calls,1);
  reopened.data.chats['private:7'].messages.push({id:'2',at:1700000010000,status:'started',source:'push'});reopened.persist();
  const afterCrash=new MessageReceiver(options);assert.equal((await afterCrash.accept(event(2),{deliver:async()=>{calls++;}})).status,'started');assert.equal(calls,1);
});

test('bounded incomplete history refuses to advance cursor or pretend recovery succeeded',async t=>{
  const {receiver}=fixture(t);let calls=0;
  await assert.rejects(receiver.reconcile(chat,{limit:2,fetchHistory:async()=>[event(1),event(2,1700000020)],enqueue:async()=>{calls++;}}),{code:'RECEIVE_HISTORY_GAP'});
  assert.equal(calls,0);assert.equal(receiver.data.chats['private:7'].through,receiver.data.since);
});

test('history errors and empty stale snapshots do not discard later delayed messages',async t=>{
  const {receiver}=fixture(t);let delivered=0;const enqueue=(e,source)=>receiver.accept(e,{source,deliver:async()=>{delivered++;return {ok:true};}});
  await assert.rejects(receiver.reconcile(chat,{fetchHistory:async()=>{throw Error('history failed');},enqueue}));
  await receiver.reconcile(chat,{fetchHistory:async()=>[],enqueue});assert.equal(receiver.data.chats['private:7'].through,receiver.data.since);
  await receiver.reconcile(chat,{fetchHistory:async()=>[event()],enqueue});assert.equal(delivered,1);
});

test('history rejects wrong private account; bot messages and pre-window history never call brain',async t=>{
  const {receiver}=fixture(t);let calls=0;const enqueue=(e,source)=>receiver.accept(e,{source,deliver:async()=>{calls++;}});
  await assert.rejects(receiver.reconcile(chat,{fetchHistory:async()=>[event(1,1700000010,{user_id:8})],enqueue}),{code:'RECEIVE_HISTORY_INVALID'});
  await assert.rejects(receiver.reconcile({kind:'group',id:'12'},{fetchHistory:async()=>[event(1,1700000010,{message_type:'group',group_id:13})],enqueue}),{code:'RECEIVE_HISTORY_INVALID'});
  await receiver.reconcile(chat,{fetchHistory:async()=>[event(2,1700000010,{user_id:9}),event(3,1699999990)],enqueue});
  await receiver.accept(event(4,1700000010,{post_type:'message_sent'}),{deliver:async()=>{calls++;}});assert.equal(calls,0);
});

test('corrupt, half-written and foreign-account state fail closed',t=>{
  const {options}=fixture(t);assert.throws(()=>new MessageReceiver({...options,selfId:8}),{code:'RECEIVE_STATE_INVALID'});
  fs.writeFileSync(options.stateFile+'.new','partial');assert.throws(()=>new MessageReceiver(options),{code:'RECEIVE_RECOVERY_REQUIRED'});
});
