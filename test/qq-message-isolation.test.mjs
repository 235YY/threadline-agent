import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shouldStopConnector,isMessageScopedFailure} from '../tools/qq-connect/bridge-policy.mjs';
import {MessageReceiver} from '../tools/qq-connect/receive.mjs';

test('provider and per-message failures do not stop the connector',()=>{
  for(const code of ['UNCERTAIN_REQUEST','PROVIDER_HTTP','INPUT_OVERFLOW','MODEL_INCOMPLETE','OUTPUT_JSON','RECEIVE_DELIVERY_FAILED']){
    assert.equal(shouldStopConnector({code}),false,code);
    assert.equal(isMessageScopedFailure({code}),true,code);
  }
});

test('identity and receive-state failures stop only the affected receiver',()=>{
  for(const code of ['QQ_IDENTITY_NOT_READY','RECEIVE_STATE_UNAVAILABLE','RECEIVE_STATE_INVALID','RECEIVE_RECOVERY_REQUIRED','RECEIVE_BACKLOG_LIMIT','CONNECTOR_OWNED']){
    assert.equal(shouldStopConnector({code}),true,code);
  }
});

test('receiver records a failed handoff and still accepts the next message',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jy-receive-'));
  const now=Date.now();
  try{
    const receiver=new MessageReceiver({stateFile:join(dir,'state.json'),selfId:'1',since:0,now:()=>now});
    const base={post_type:'message',message_type:'private',user_id:'2',time:Math.floor((now-2000)/1000),message:[{type:'text',data:{text:'A'}}]};
    await assert.rejects(receiver.accept({...base,message_id:'1'},{deliver:()=>{throw Object.assign(new Error('uncertain'),{code:'UNCERTAIN_REQUEST'});}}),/uncertain/);
    const second=await receiver.accept({...base,message_id:'2',message:[{type:'text',data:{text:'B'}}]},{deliver:()=>Promise.resolve({ok:true})});
    assert.equal(second.accepted,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

