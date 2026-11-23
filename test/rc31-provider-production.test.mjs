import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {putBlob} from '../src/blobs.mjs';
import {message,textPart,imagePart} from '../src/message.mjs';
import {createModelDecision,toProviderMessages} from '../src/model-transport.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {keepAttention} from '../src/attention.mjs';

const attention=()=>({...keepAttention()});
test('RC3.1 production decide sends the current event image in one provider message',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'rc31-provider-'));
  const blob=putBlob({directory:dir,bytes:Buffer.from('image'),mediaType:'image/png',sourceUrl:'https://example.com/image.png'});
  let captured=null;
  const transport=async (_url,options)=>{
    captured=JSON.parse(options.body);
    const user=captured.messages.find(m=>m.role==='user');
    let packetId;
    try{const text=Array.isArray(user.content)?user.content.find(x=>x.type==='text')?.text:user.content;packetId=JSON.parse(text).packetId;}catch{}
    const content=JSON.stringify({packetId,options:[{id:'r',kind:'respond',payload:{text:'看到了'}}],selected:'r',summary:'respond',used:[],
      continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
    return new Response(JSON.stringify({id:'fake',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:2,completion_tokens:1,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const model=createModelDecision({ledgerPath:join(dir,'budget.json'),blobDirectory:dir,transport,networkCheck:async()=>({ok:true}),getKey:()=>'sk-test-123456789012',profile:{dailyMicros:1000000,dailyCalls:10,maxTokens:3000,reasoning:'off'}});
  const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,global:true,blobDirectory:dir,decide:model.decide});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();model.close();});
  const m=message('user',[textPart('这啥'),imagePart({ref:blob.ref,mediaType:blob.mediaType,bytes:blob.bytes,sourceUrl:'https://example.com/image.png'})]);
  const result=await service.reply({key:'private:7',scene:'qq/private/7',message_id:'prod-image',message:m,execute:false});
  console.error('RESULT',JSON.stringify(result));assert.equal(result.ok,true);
  assert.ok(captured);
  const user=captured.messages.find(x=>x.role==='user');
  assert.equal(user.content.length,2);
  assert.equal(user.content[1].type,'image_url');
  assert.match(user.content[1].image_url.url,/^data:image\/png;base64,/);
});

test('task interrupt messageParts image is appended to provider input',async()=>{
  const {mkdtempSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {putBlob}=await import('../src/blobs.mjs');const {message,textPart,imagePart}=await import('../src/message.mjs');
  const dir=mkdtempSync(join(tmpdir(),'rc312-interrupt-img-'));const b=putBlob({directory:dir,bytes:Buffer.from('x'),mediaType:'image/png'});
  const im=message('user',[textPart('看'),imagePart({ref:b.ref,mediaType:b.mediaType,bytes:b.bytes})]);
  const packet={payload:{current:{message:null},task:{interrupts:[{messageParts:im}]}}};
  const out=toProviderMessages([{role:'user',content:'任务'}],{blobDirectory:dir,packet});
  assert.equal(out[0].content.length,2);assert.equal(out[0].content[1].type,'image_url');assert.match(out[0].content[1].image_url.url,/^data:image\/png;base64,/);
});
