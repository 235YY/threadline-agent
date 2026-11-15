import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {pricedUsage,StudyLedger,DeepSeekStudyClient} from '../src/model-client.mjs';
import {DailyBudgetLedger} from '../src/model-transport.mjs';
import {ContinuityStore} from '../src/store.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {TaskStore} from '../src/tasks.mjs';
import {listOffice,officeRoot} from '../src/office.mjs';
import {keepAttention} from '../src/attention.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {executeTool} from '../tools/qq-connect/tools.mjs';
import {runDesktop} from '../tools/native-capabilities/desktop.mjs';
import {runMinecraft} from '../tools/native-capabilities/minecraft.mjs';
import {event,frame,put,ref} from './helpers.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const APP_ROOT=resolve(HERE,'..');

function makeTempDir(prefix){
  return mkdtempSync(join(tmpdir(),prefix));
}

test('ui/index.html uses agent-brain-bridge-v1 protocol, owner sender, execute:true, and updated error texts',()=>{
  const html=readFileSync(join(APP_ROOT,'tools/ui/index.html'),'utf8');
  assert.match(html,/agent-brain-bridge-v1/);
  assert.match(html,/execute:\s*true/);
  assert.match(html,/MODEL_KEY_REQUIRED/);
  assert.match(html,/PROVIDER_AUTH/);
  assert.match(html,/UNCERTAIN_REQUEST/);
  assert.doesNotMatch(html,/3482479936/);
  assert.doesNotMatch(html,/jingyang-brain-bridge-v1/);
  assert.doesNotMatch(html,/鲸漾/);
});

test('pricedUsage supports OpenAI-style usage and StudyLedger/DailyBudgetLedger treat failed as zero cost',()=>{
  const u1=pricedUsage({prompt_tokens:100,completion_tokens:10});
  assert.equal(u1.hit,0);
  assert.equal(u1.miss,100);
  assert.equal(u1.upperMicros,280);

  const u2=pricedUsage({prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:40}});
  assert.equal(u2.hit,40);
  assert.equal(u2.miss,60);

  const dir=makeTempDir('tl-ledger-');
  try{
    const sl=new StudyLedger(join(dir,'study.json'),{limitMicros:1000,maxCalls:4});
    sl.reserve('r1','fp1',900);
    sl.dispatch('r1');
    sl.fail('r1','PROVIDER_AUTH_401');
    // failed request frees reserved budget and does not halt ledger
    sl.reserve('r2','fp2',900);
    sl.close();

    const dl=new DailyBudgetLedger(join(dir,'daily.json'),{dailyMicros:1000,dailyCalls:4});
    dl.reserve('d1','fp1',900);
    dl.dispatch('d1');
    dl.fail('d1','PROVIDER_HTTP_400');
    dl.reserve('d2','fp2',900);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test('DeepSeekStudyClient marks HTTP 4xx as failed (not uncertain) and preserves httpStatus without halting budget',async()=>{
  const dir=makeTempDir('tl-client-');
  const store=new ContinuityStore(':memory:');
  try{
    const ev=put(store,'ev1',event('ev1',{body:'hello',scene:'local/owner',occurredAt:1000}))[0];
    const ws=put(store,'ws1',frame({id:'ws:local/owner',scene:'local/owner'}))[0];
    const packet={
      packetId:'pkt-1',
      bytes:20,
      messages:[{role:'user',content:'hi'}],
      currentEvent:ref(ev),
      workspace:ref(ws),
      observations:[{ref:ref(ev),body:'hello'}],
      memories:[],
      allowedActionTools:[],
      stage:'decision',
    };
    const ledger=new StudyLedger(join(dir,'study.json'),{limitMicros:500000,maxCalls:5});
    let calls=0;
    const client=new DeepSeekStudyClient({
      ledger,
      getKey:()=>'sk-testkey1234567890',
      inputVerifier:p=>({bytes:20,messages:p.messages}),
      networkCheck:async()=>({ok:true,classification:'mock'}),
      transport:async()=>{
        calls++;
        if(calls===1)return new Response('unauthorized',{status:401});
        return new Response(JSON.stringify({
          usage:{prompt_tokens:10,completion_tokens:5},
          choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],
        }),{status:200,headers:{'content-type':'application/json'}});
      },
    });
    await assert.rejects(
      ()=>client.call({id:'c1',packet}),
      err=>err.code==='PROVIDER_AUTH'&&err.details?.httpStatus===401
    );
    assert.equal(ledger.data.halted,null);
    const res=await client.call({id:'c2',packet});
    assert.equal(res.output,'{"ok":true}');
    ledger.close();
  }finally{
    store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('TurnDriver.#commitWithFallback preserves reply when continuity update fails on string model output',async()=>{
  const store=new ContinuityStore(':memory:');
  try{
    const dir=makeTempDir('tl-driver-');
    try{
      const now=Date.UTC(2026,10,7,10,0,0);
      const ws=put(store,'ws:fallback',frame({id:'ws:local/owner',scene:'local/owner'}))[0];
      const driver=new TurnDriver({
        store,
        subjectId:'agent',
        workspace:ref(ws),
        identity:'agent',
        stateDirectory:dir,
        allowedActionTools:[],
        decide:packet=>{
          const conflictResidency={add:['state:conflict'],remove:['state:conflict']};
          const continuity=packet.stage==='reflection'
            ?{changes:[],residency:conflictResidency,attention:keepAttention()}
            :{changes:[],residency:conflictResidency,expressionChoice:null,observationDisposition:'handled',attention:keepAttention()};
          return JSON.stringify({
            packetId:packet.packetId,
            options:[{id:'r',kind:'respond',payload:{text:'still here'}}],
            selected:'r',
            summary:'reply despite bad continuity ref',
            used:[],
            continuity,
          });
        },
      });
      const ev=put(store,'obs1',event('ev:fallback:1',{
        body:'hi',scene:'local/owner',origin:'reported',
        source:{system:'local',key:'owner'},actor:'owner',occurredAt:now,
      }))[0];
      store.execute({requestId:'admit1',commands:[{op:'admit_subject_event',subjectId:'agent',event:ref(ev)}]});
      const tick=await driver.tick({now,eventId:'ev:fallback:1'});
      assert.match(tick.decision.id,/:fallback$/);
      assert.deepEqual(driver.takeOutbox().map(x=>x.text),['still here']);
    }finally{
      rmSync(dir,{recursive:true,force:true});
    }
  }finally{
    store.close();
  }
});

test('brain-service handles /v1/settings/key with custom keyFile and isolates /v1/reply execute=false from prior queued events',async()=>{
  const dir=makeTempDir('tl-brain-');
  const executed=[];
  let seq=0;
  const service=await startBrainService({
    storePath:join(dir,'memory.sqlite'),
    taskStorePath:join(dir,'tasks.sqlite'),
    stateDirectory:join(dir,'state'),
    styleDirectory:join(dir,'style'),
    keyFile:join(dir,'deepseek.key'),
    heartbeatMs:0,
    taskTickMs:0,
    global:true,
    decide:packet=>{
      seq++;
      const text=packet.stage==='reflection'?'refl':`reply-${seq}`;
      const continuity=packet.stage==='reflection'
        ?{changes:[],residency:{add:[],remove:[]},attention:keepAttention()}
        :{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()};
      return JSON.stringify({
        packetId:packet.packetId,
        options:[{id:'s',kind:'respond',payload:{text}}],
        selected:'s',
        summary:'ok',
        used:[],
        continuity,
      });
    },
    adapter:{send:async item=>{executed.push({scene:item.scene,text:item.text});return {delivered:true};}},
  });
  try{
    // Queue another scene's event first
    const obsRes=await fetch(`${service.url}/v1/observe`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({source:'qq',key:'private:999',scene:'qq/private/999',text:'first message'}),
    });
    assert.equal(obsRes.status,200);

    // Local /v1/reply with execute:false should still allow the prior qq event to execute
    // and return only its own outbox
    const repRes=await fetch(`${service.url}/v1/reply`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({protocol:'agent-brain-bridge-v1',scene:'local/owner',execute:false,text:'second message'}),
    });
    assert.equal(repRes.status,200);
    const body=await repRes.json();
    assert.equal(body.ok,true);
    assert.equal(executed.length,1);
    assert.equal(executed[0].scene,'qq/private/999');
    assert.notEqual(body.text,executed[0].text);

    // /v1/settings/key writes to configured keyFile
    const keyRes=await fetch(`${service.url}/v1/settings/key`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({key:'sk-localtestkey12345'}),
    });
    assert.equal(keyRes.status,200);
    assert.equal(readFileSync(join(dir,'deepseek.key'),'utf8').trim(),'sk-localtestkey12345');
  }finally{
    service.server.close();
    service.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('TaskStore.update validates nextWakeAt and office.listOffice survives dangling symlinks',async()=>{
  const dir=makeTempDir('tl-office-');
  const tasks=new TaskStore(join(dir,'tasks.sqlite'));
  try{
    const created=tasks.create({subject:'agent',goal:'check nextWakeAt'});
    assert.throws(
      ()=>tasks.update({id:created.id,expectedRevision:created.revision,patch:{nextWakeAt:Number.NaN}}),
      err=>err.code==='TASK_INPUT'
    );
    assert.throws(
      ()=>tasks.update({id:created.id,expectedRevision:created.revision,patch:{nextWakeAt:-5}}),
      err=>err.code==='TASK_INPUT'
    );
    const updated=tasks.update({id:created.id,expectedRevision:created.revision,patch:{nextWakeAt:12345}});
    assert.equal(updated.nextWakeAt,12345);

    const office=join(dir,'office');
    mkdirSync(office,{recursive:true});
    writeFileSync(join(office,'hello.txt'),'world','utf8');
    const prevOffice=process.env.AGENT_OFFICE_ROOT;
    process.env.AGENT_OFFICE_ROOT=office;
    try{
      assert.equal(officeRoot(),office);
      try{
        symlinkSync(join(office,'missing-target.txt'),join(office,'dangling.txt'));
      }catch(e){
        if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;
      }
      const listed=listOffice({root:office});
      assert.ok(listed.entries.some(e=>e.name==='hello.txt'&&e.size===5));
    }finally{
      if(prevOffice===undefined)delete process.env.AGENT_OFFICE_ROOT;
      else process.env.AGENT_OFFICE_ROOT=prevOffice;
    }
  }finally{
    tasks.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('native capabilities and web_fetch fail cleanly without hardcoded legacy paths and enforce SSRF',async()=>{
  await assert.rejects(()=>runDesktop({action:'status'}),/THREADLINE_DESKTOP_MODULE/);
  await assert.rejects(()=>runMinecraft({action:'status'}),/THREADLINE_MINECRAFT_MODULE/);
  await assert.rejects(()=>executeTool('web_fetch',{url:'http://127.0.0.1:8787/health'}),/内网|本机/);
  const voices=await executeTool('qq_list_voices',{});
  assert.ok(Array.isArray(voices));
});
