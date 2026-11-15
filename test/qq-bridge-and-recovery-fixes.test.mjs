import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyBridgeError,isAddressed,applyContextToParts,normalizeNoticeEvent} from '../tools/qq-connect/bridge-helpers.mjs';
import {createModelDecision} from '../src/model-transport.mjs';
import {DeepSeekStudyClient,StudyLedger} from '../src/model-client.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {affectFactory,AffectSession} from '../tools/affect-integrated/session.mjs';
import {keepAttention} from '../src/attention.mjs';
import {textPart} from '../src/message.mjs';
import {ContinuityStore} from '../src/store.mjs';
import {executeTool} from '../tools/qq-connect/tools.mjs';

const KEY='sk-abcdefghijklmnop';
const okDecision=p=>JSON.stringify({packetId:p.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'synthetic wait',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});

test('bridge helpers classify quota vs fatal vs transient errors without wedging on transient failures',()=>{
  for(const code of ['DAILY_BUDGET_LIMIT','SPEND_LIMIT','CALL_LIMIT','BUDGET_EXPIRED','BUDGET_HALTED']){
    assert.equal(classifyBridgeError({code}),'quota');
  }
  for(const code of ['RECEIVE_STATE_UNAVAILABLE','RECEIVE_RECOVERY_REQUIRED','RECEIVE_STATE_INVALID','RECEIVE_BACKLOG_LIMIT']){
    assert.equal(classifyBridgeError({code}),'fatal');
  }
  assert.equal(classifyBridgeError({code:'BRAIN_UNAVAILABLE'}),'transient');
  assert.equal(classifyBridgeError(new Error('network blip')),'transient');
});

test('bridge addressed() allows private chats and gates group chats by mention or wake words',()=>{
  const wakeWords=['鲸鱼','在吗'];
  assert.equal(isAddressed({message_type:'private',message:[{type:'text',data:{text:'hi'}}]},{selfId:'99',wakeWords}),true);
  assert.equal(isAddressed({message_type:'group',message:[{type:'text',data:{text:'随便聊聊'}}]},{selfId:'99',wakeWords}),false);
  assert.equal(isAddressed({message_type:'group',message:[{type:'at',data:{qq:'99'}},{type:'text',data:{text:' 帮我看看'}}]},{selfId:'99',wakeWords}),true);
  assert.equal(isAddressed({message_type:'group',message:[{type:'text',data:{text:'鲸鱼在干嘛'}}]},{selfId:'99',wakeWords}),true);
  assert.equal(isAddressed({message_type:'group',message:[{type:'text',data:{text:'随便聊聊'}}]},{selfId:'99',wakeWords,listenAll:true}),true);
});

test('bridge context merging preserves multiline quote and forward messages',()=>{
  const parts=applyContextToParts([textPart('你好')],{
    context:'ignored fallback',
    quoteText:'[引用 Alice：第一行\n第二行 [含括号]]',
    forwardText:'[合并转发：甲: 换行1\n换行2]',
    textPart
  });
  assert.equal(parts[0].text,'[引用 Alice：第一行\n第二行 [含括号]]\n');
  assert.equal(parts[1].text,'你好\n[合并转发：甲: 换行1\n换行2]');

  const fallbackParts=applyContextToParts([textPart('回复')],{
    context:'[引用 Bob：多行\n内容]\n回复\n[合并转发：A\nB]',
    textPart
  });
  assert.equal(fallbackParts[0].text,'[引用 Bob：多行\n内容]\n');
  assert.equal(fallbackParts[1].text,'回复\n[合并转发：A\nB]');
});

test('bridge notice normalizer routes private notify cleanly instead of qq/group/undefined',()=>{
  const privateNotify=normalizeNoticeEvent({notice_type:'notify',user_id:7,time:1700000000},{ownerQQ:'7'});
  assert.equal(privateNotify.scene,'qq/private/7');
  assert.equal(privateNotify.key,'private:7');
  assert.equal(privateNotify.sender.isOwner,true);

  const groupNotify=normalizeNoticeEvent({notice_type:'notify',group_id:100,user_id:8,time:1700000000},{ownerQQ:'7'});
  assert.equal(groupNotify.scene,'qq/group/100');
  assert.equal(groupNotify.key,'group:100');

  assert.equal(normalizeNoticeEvent({notice_type:'notify'}),null);
});

test('bridge source uses shared helper policies and rolls back seen dedup before reply fetch',()=>{
  const src=readFileSync(new URL('../tools/qq-connect/bridge.mjs',import.meta.url),'utf8');
  assert.ok(src.includes("if(!replyAttempted)seen.delete(dedupKey);"));
  assert.ok(!src.includes("if(!addressed(event))return;\n  const scene"));
  assert.ok(src.includes("if(kind==='quota')"));
  assert.ok(src.includes("if(kind==='fatal')"));
});

test('model-client attaches transportInvoked=false on pre-transport errors even when requireMonitor is false',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-unsent-proof-'));
  const ledger=new StudyLedger(join(dir,'budget.json'),{limitMicros:1});
  t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
  let sends=0;
  const client=new DeepSeekStudyClient({ledger,getKey:()=>KEY,networkCheck:async()=>({ok:true}),inputVerifier:p=>p,transport:async()=>{sends++;throw Error('must not send');}});
  await assert.rejects(
    client.call({id:'t1',packet:{packetId:'p1',bytes:100,messages:[{role:'user',content:'hi'}]}}),
    e=>e.code==='SPEND_LIMIT'&&e.transportInvoked===false
  );
  assert.equal(sends,0);
});

test('real SPEND_LIMIT from createModelDecision auto-recovers in AffectSession host and next day/larger input can proceed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-real-quota-host-'));
  const ledgerPath=join(dir,'budget.json');
  const model=createModelDecision({ledgerPath,getKey:()=>KEY,networkCheck:async()=>({ok:true}),transport:async()=>new Response('{}',{status:200}),profile:{dailyMicros:1}});
  let allowModel=false,calls=0;
  const s=await startBrainService({
    port:0,storePath:join(dir,'subject.sqlite'),stateDirectory:join(dir,'state'),
    global:true,heartbeatMs:0,allowedActionTools:[],sessionFactory:affectFactory({fusion:true}),
    runtimeInfo:{ledgerPath},
    decide:async p=>{calls++;if(!allowModel)return model.decide(p);return okDecision(p);}
  });
  t.after(async()=>{if(s.server.listening)await new Promise(r=>s.server.close(r));s.close();model.close();rmSync(dir,{recursive:true,force:true});});
  const first=await s.reply({scene:'qq/private/7',key:'private:7',message_id:'q1',messages:[{role:'user',content:'hello'}]});
  assert.equal(first.ok,false);
  assert.equal(first.error,'SPEND_LIMIT');
  assert.equal(s.health().recovery.modelTurnCount,0);
  assert.equal([...s.store.all('affect_turn')][0].status,'closed-incomplete');
  allowModel=true;
  const second=await s.reply({scene:'qq/private/7',key:'private:7',message_id:'q2',messages:[{role:'user',content:'next'}]});
  assert.equal(second.ok,true);
  assert.equal(calls,2);
});

test('settled AFFECT_OUTPUT_LIMIT (>32KB) closes cleanly via closeRecoveryTurn without wedging subsequent turns',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-output-limit-recover-'));
  const ledgerPath=join(dir,'budget.json');
  const runtimeInfo={ledgerPath};
  const s=await startBrainService({port:0,storePath:join(dir,'subject.sqlite'),stateDirectory:join(dir,'state'),global:true,heartbeatMs:0,sessionFactory:affectFactory({fusion:true}),runtimeInfo,decide:p=>okDecision(p)});
  t.after(async()=>{if(s.server.listening)await new Promise(r=>s.server.close(r));s.close();rmSync(dir,{recursive:true,force:true});});
  const a=new AffectSession({store:s.store,subjectId:'jingyang',fusion:true});
  const T=1794400000000;
  s.store.execute({requestId:'seed',commands:[
    {op:'append_event',id:'oversized-ev',body:'trigger',scene:'qq/private/7',actor:'u',occurredAt:T,origin:'reported',source:{system:'qq',key:'oversized-ev'}},
    {op:'set_workspace',id:'w-ov',expectedRevision:0,scene:'qq/private/7',focus:{id:'now',label:'test'}}
  ]});
  const packet=await a.prepare({currentEvent:{id:'oversized-ev',revision:1},workspace:{id:'w-ov',revision:1},budgetBytes:131072,now:T});
  const huge='{"x":"'+'a'.repeat(33000)+'"}';
  await assert.rejects(a.invoke(packet,()=>huge),{code:'AFFECT_OUTPUT_LIMIT'});
  const turn=[...s.store.all('affect_turn')][0];
  assert.equal(turn.status,'uncertain');
  const ledgerBytes=JSON.stringify({format:'jingyang-daily-brain-budget-v1',requests:[{id:'turn:'+packet.packetId,status:'settled',reserveMicros:100,actualMicros:42,output:huge}]});
  writeFileSync(ledgerPath,ledgerBytes);
  const closed=s.closeRecoveryTurn({turnId:turn.id,expectedRevision:turn.revision,ledgerHash:createHash('sha256').update(ledgerBytes).digest('hex')});
  assert.equal(closed.status,'closed-incomplete');
  assert.equal(s.health().recovery.modelTurnCount,0);
});

test('dispatch respond failure with transportInvoked=false marks response failed instead of unknown',async t=>{
  const s=await startBrainService({
    port:0,storePath:':memory:',global:true,heartbeatMs:0,
    adapter:{send:async()=>{throw Object.assign(Error('invalid recipient'),{code:'QQ_TARGET_ARGUMENTS',transportInvoked:false});}},
    decide:p=>JSON.stringify({packetId:p.packetId,options:[{id:'r',kind:'respond',payload:{text:'hi'}}],selected:'r',summary:'reply',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}})
  });
  t.after(async()=>{await new Promise(r=>s.server.close(r));s.close();});
  const res=await s.reply({scene:'qq/private/7',key:'private:7',message_id:'r1',execute:true,messages:[{role:'user',content:'hi'}]});
  assert.equal(res.ok,true);
  const response=[...s.store.all('response')][0];
  assert.equal(response.status,'failed');
  assert.equal(s.health().recovery.responses.unconfirmed,0);
});

test('reply() does not sleep 3 seconds when deferred by budget/rhythm',async t=>{
  const s=await startBrainService({
    port:0,storePath:':memory:',global:true,heartbeatMs:0,rhythm:{dailyCallCap:0},
    decide:p=>okDecision(p)
  });
  t.after(async()=>{await new Promise(r=>s.server.close(r));s.close();});
  const started=Date.now();
  const res=await s.reply({scene:'qq/private/7',key:'private:7',message_id:'def1',messages:[{role:'user',content:'hi'}]});
  const elapsed=Date.now()-started;
  assert.equal(res.deferred,true);
  assert.ok(elapsed<1000,`expected fast deferred return (<1000ms), got ${elapsed}ms`);
});

test('qq tools mark pre-transport missing file/config errors as transportInvoked=false',async()=>{
  await assert.rejects(executeTool('qq_send_voice',{target:'private',id:'10001',file:'Z:/nonexistent-voice-file-xyz.mp3'}),e=>e.transportInvoked===false);
  await assert.rejects(executeTool('qq_send_poke',{target:'private'}),e=>e.code==='TOOL_ARGUMENTS'&&e.transportInvoked===false);
});
