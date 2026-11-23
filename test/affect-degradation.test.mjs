// Phase 3.2 Limbic degradation contract (D ownership).
// Covers: probe failure classification (environment vs configuration), effective
// plan (degraded => no AffectSession / fusion off), degraded core continues,
// runtime asset path resolution, fusion fallbacks, and a full non-fusion chain
// on the packaged runtime (event -> appraisal -> state -> persistence -> next input).
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ContinuityStore} from '../src/store.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {launchBrain} from '../tools/brain-service/bootstrap.mjs';
import {motivationId,affectTurnId} from '../src/affect-contract.mjs';
import {
  probeAffect,probeAffectSafe,planAffectRuntime,prepareAffectRuntime,resolveAffectRuntimeAsset,
  affectFactory,affectTheoryStatus
} from '../tools/affect-integrated/session.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';

const T=1794400000000;
const ref=x=>({id:x.id,revision:x.revision});
const failedWorker=code=>async()=>{throw Object.assign(new Error(`synthetic ${code}`),{code});};
const okProbe={available:true,degraded:false,upstream:'synthetic-upstream',profileHash:'synthetic-profile',fusionSupported:true};
const failedProbe={available:false,degraded:true,code:'WORKER_UNAVAILABLE',message:'worker unavailable',fusionSupported:false};

test('probe failure: environment errors are classified, configuration errors still throw',async()=>{
  for(const code of ['WORKER_UNAVAILABLE','WORKER_TIMEOUT','WORKER_EXIT','WORKER_PROTOCOL','WORKER_REJECTED','WORKER_OUTPUT_LIMIT','ENOENT']){
    const safe=await probeAffectSafe({worker:failedWorker(code)});
    assert.equal(safe.available,false);assert.equal(safe.degraded,true);assert.equal(safe.code,code);
    assert.equal(safe.fusionSupported,false);assert.ok(safe.message.length<=240);
    await assert.rejects(probeAffect({worker:failedWorker(code)}),{code});
  }
  await assert.rejects(probeAffectSafe({worker:failedWorker('AFFECT_PROFILE')}),{code:'AFFECT_PROFILE'});
  await assert.rejects(probeAffectSafe({worker:failedWorker('AFFECT_STATE')}),{code:'AFFECT_STATE'});
});

test('plan: probe failure degrades to core-only (no session factory, fusion off), requested flags stay visible',()=>{
  const plan=planAffectRuntime({affect:{enabled:true,fusion:true},probe:failedProbe});
  assert.equal(plan.enabled,false);assert.equal(plan.fusion,false);assert.equal(plan.sessionFactory,null);
  assert.equal(plan.degraded,true);assert.equal(plan.code,'WORKER_UNAVAILABLE');
  assert.deepEqual(plan.requested,{enabled:true,fusion:true});
  const theory=affectTheoryStatus(plan);
  assert.equal(theory.enabled,false);assert.equal(theory.available,false);assert.equal(theory.degraded,true);
  assert.equal(theory.code,'WORKER_UNAVAILABLE');
  const off=planAffectRuntime({affect:{enabled:false,fusion:false},probe:null});
  assert.equal(off.enabled,false);assert.equal(off.degraded,false);assert.equal(off.sessionFactory,null);
});

test('fusion fallback: unsupported fusion falls back to non-fusion affect; disabled fusion stays off',()=>{
  const unsupported=planAffectRuntime({affect:{enabled:true,fusion:true},probe:{...okProbe,fusionSupported:false}});
  assert.equal(unsupported.enabled,true);assert.equal(unsupported.fusion,false);
  assert.equal(unsupported.degraded,false);assert.equal(unsupported.fusionFallback,true);
  assert.equal(typeof unsupported.sessionFactory,'function');
  assert.equal(affectTheoryStatus(unsupported).enabled,true);
  const fusionOff=planAffectRuntime({affect:{enabled:true,fusion:false},probe:okProbe});
  assert.equal(fusionOff.enabled,true);assert.equal(fusionOff.fusion,false);
});

test('degraded core continues: null session factory serves a full ordinary reply without affect writes',async()=>{
  const plan=planAffectRuntime({affect:{enabled:true,fusion:true},probe:failedProbe});
  const service=createBrainService({storePath:':memory:',stateDirectory:null,heartbeatMs:0,global:true,sessionFactory:plan.sessionFactory});
  try{
    service.observe({source:'synthetic',key:'synthetic:1',scene:'synthetic',text:'合成降级消息',occurredAt:T});
    const result=await service.turn();
    assert.equal(result.ok,true,JSON.stringify(result.error??result));
    assert.ok([...service.store.all('decision')].length>=1);
    assert.equal([...service.store.all('motivation_state')].length,0);
    assert.equal([...service.store.all('affect_turn')].length,0);
    assert.equal([...service.store.all('personal_state')].length,0);
  }finally{service.close();}
});

test('runtime asset path: packaged default + explicit operator override + missing asset degrades',async()=>{
  const packaged=resolveAffectRuntimeAsset({root:process.cwd(),env:{}});
  assert.equal(packaged.source,'packaged');assert.ok(packaged.path.endsWith('python.exe'));
  assert.equal(packaged.path,join(process.cwd(),'_local','affect-runtime','python-3.13.9','python.exe'));
  assert.equal(packaged.exists,existsSync(packaged.path));
  assert.ok(packaged.provenancePath.endsWith('PROVENANCE.json'));
  const override=resolveAffectRuntimeAsset({root:process.cwd(),env:{JY_AFFECT_PYTHON:'C:\\tools\\python.exe'}});
  assert.equal(override.source,'operator-provided');assert.equal(override.path,'C:\\tools\\python.exe');assert.equal(override.exists,false);
  // missing asset must degrade, not throw, even before any worker probe
  const missing=await prepareAffectRuntime({affect:{enabled:true,fusion:true},asset:{exists:false},worker:failedWorker('WORKER_UNAVAILABLE')});
  assert.equal(missing.plan.enabled,false);assert.equal(missing.plan.code,'AFFECT_RUNTIME_MISSING');assert.equal(missing.plan.sessionFactory,null);
});

test('full chain on packaged runtime: event -> appraisal -> motivation_state -> next input (non-fusion)',async t=>{
  const asset=resolveAffectRuntimeAsset({root:process.cwd(),env:{}});
  assert.equal(asset.exists,true,'packaged affect runtime is required for the full-chain test');
  const store=new ContinuityStore(':memory:',{clock:()=>T});t.after(()=>store.close());
  store.execute({requestId:'ws',commands:[{op:'set_workspace',id:'w',expectedRevision:0,scene:'synthetic',focus:{id:'now',label:'合成场景'}}]});
  const packets=[];let n=0;
  const decide=p=>{
    packets.push(p);
    const output=proposal(p);
    if(p.payload.current){
      // non-fusion appraisal shape: exactly source_refs + appraisals
      output.affectAppraisal={source_refs:[ref(p.payload.current)],
        appraisals:[{weight:1,value:{event:'synthetic-event',summary:'合成事件',valence:.2,intensity:.6,relevance:.7,agency:'circumstance'}}]};
    }else{
      delete output.continuity.observationDisposition;delete output.continuity.expressionChoice;
    }
    return JSON.stringify(output);
  };
  const driver=new TurnDriver({store,subjectId:'s',workspace:'w',identity:'离线合成主体',eventBypass:true,
    sessionFactory:affectFactory({fusion:false,clock:()=>T}),decide});
  driver.ingest({key:'message:1',body:'第一条合成消息',scene:'synthetic',at:T});
  const first=await driver.tick({now:T,eventBypass:true});
  assert.equal(first.action,'decided');
  const stateAfterFirst=store.read(motivationId('s'));
  assert.equal(stateAfterFirst?.type,'motivation_state');assert.ok(stateAfterFirst.revision>=2);
  assert.equal([...store.all('affect_turn')].filter(x=>x.status==='committed').length,1);
  driver.ingest({key:'message:2',body:'第二条合成消息',scene:'synthetic',at:T+1000});
  const second=await driver.tick({now:T+1000,eventBypass:true});
  assert.equal(second.action,'decided');
  assert.equal([...store.all('decision')].length,2);
  const secondPacket=packets.at(-1);
  assert.ok(secondPacket.payload.continuity.motivation,'next input must carry the motivation projection');
  assert.equal(secondPacket.payload.continuity.motivation.canAppraiseCurrent,true);
  assert.ok(secondPacket.payload.continuity.motivation.projection.emotions.length>=1);
  assert.equal(secondPacket.payload.continuity.motivation.ref.id,stateAfterFirst.id);
  const head=store.read(motivationId('s'));
  assert.ok(head.revision>stateAfterFirst.revision);
  assert.ok([...store.all('affect_turn')].some(x=>x.status==='committed'));
  assert.equal([...store.all('personal_state')].length,0,'affect must not manufacture personal memories');
});

// ---- launchBrain-level wiring (A owns bootstrap; D verifies public behavior) ----
function launchEnv(extra={}){
  const dir=mkdtempSync(join(tmpdir(),'jy-affect-degrade-'));
  return {root:process.cwd(),dir,env:{BRAIN_PORT:'0',BRAIN_HEARTBEAT_MS:'0',BRAIN_STORE:join(dir,'subject.sqlite'),
    BRAIN_STATE:join(dir,'state'),BRAIN_STYLE_DIR:join(dir,'style'),...extra}};
}
async function replyOnce(service,id='1',key='synthetic'){
  return service.reply({scene:'synthetic',key,message_id:id,messages:[{role:'user',content:'合成降级消息'}],execute:false});
}
async function expectDegraded(extra,codePattern){
  const {root,env}=launchEnv(extra),running=await launchBrain({root,env});
  try{
    assert.equal(running.summary.affect,false);assert.equal(running.summary.fusion,false);
    assert.equal(running.summary.affectRequested,true);
    assert.match(running.summary.affectDegraded?.code??'',codePattern);
    const health=running.service.health();
    assert.equal(health.theory.enabled,false);assert.equal(health.theory.available,false);assert.equal(health.theory.degraded,true);
    assert.equal(health.runtime.affect.degraded,true,'operator health carries the degradation reason');
    assert.match(health.runtime.affect.reason??'',codePattern);
    assert.equal(running.instance.affect,false);assert.equal(running.instance.fusion,false);
    const reply=await replyOnce(running.service);
    assert.equal(reply.ok,true,JSON.stringify(reply.error??reply));
    assert.ok([...running.service.store.all('decision')].length>=1,'core dialogue must keep deciding');
    assert.equal([...running.service.store.all('motivation_state')].length,0);
    assert.equal([...running.service.store.all('affect_turn')].length,0);
    return running;
  }catch(error){try{await running.stop();}catch{};throw error;}
}

test('launch degrades on missing runtime asset, rolls back implicit fusion apperception, core serves a reply',async()=>{
  const running=await expectDegraded({JY_AFFECT:'1',JY_AFFECT_FUSION:'1',JY_AFFECT_PYTHON:join(tmpdir(),'absent-affect-python.exe')},/AFFECT_RUNTIME_MISSING/);
  try{
    assert.equal(running.instance.cognition.apperceptionV1,false,'fusion-implicit apperception must roll back when degraded');
    assert.equal(running.config.cognition.apperceptionV1,true,'requested config is not mutated/lied about');
  }finally{await running.stop();}
});

test('launch keeps an explicit apperception flag while degraded',async()=>{
  const running=await expectDegraded({JY_AFFECT:'1',JY_AFFECT_FUSION:'1',JY_APPERCEPTION_V1:'1',JY_AFFECT_PYTHON:join(tmpdir(),'absent-affect-python.exe')},/AFFECT_RUNTIME_MISSING/);
  try{assert.equal(running.instance.cognition.apperceptionV1,true);}finally{await running.stop();}
});

test('launch degrades on real worker environment failure in a child process (probe no longer refuses startup)',()=>{
  const {dir}=launchEnv({});
  const env={...process.env,JY_AFFECT:'1',JY_AFFECT_FUSION:'1',JY_AFFECT_PYTHON:process.execPath,
    BRAIN_PORT:'0',BRAIN_HEARTBEAT_MS:'0',BRAIN_STORE:join(dir,'subject.sqlite'),BRAIN_STATE:join(dir,'state'),BRAIN_STYLE_DIR:join(dir,'style')};
  delete env.JY_APPERCEPTION_V1;
  // The worker launcher reads JY_AFFECT_PYTHON at module load, so this path must be
  // exercised in a fresh process: node-as-python makes every spawn exit non-zero.
  const child=`import('./tools/brain-service/bootstrap.mjs').then(async m=>{
    const running=await m.launchBrain();
    const reply=await running.service.reply({scene:'synthetic',key:'synthetic',message_id:'1',messages:[{role:'user',content:'child'}],execute:false});
    const out={summary:running.summary,health:running.service.health(),
      decisions:[...running.service.store.all('decision')].length,
      motivation:[...running.service.store.all('motivation_state')].length,
      affectTurns:[...running.service.store.all('affect_turn')].length,
      instance:{affect:running.instance.affect,fusion:running.instance.fusion,apperceptionV1:running.instance.cognition.apperceptionV1},
      replyOk:reply.ok};
    await running.stop();console.log(JSON.stringify(out));
  }).catch(e=>{console.error('CHILD_ERR',e.code,e.message);process.exit(1)});`;
  const childResult=spawnSync(process.execPath,['-e',child],{cwd:process.cwd(),env,encoding:'utf8',timeout:120000});
  assert.equal(childResult.status,0,childResult.stderr);
  const line=childResult.stdout.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1);
  const out=JSON.parse(line);
  assert.equal(out.summary.affect,false);assert.equal(out.summary.affectRequested,true);
  assert.match(out.summary.affectDegraded?.code??'',/WORKER_/);
  assert.equal(out.health.theory.degraded,true);assert.equal(out.health.theory.enabled,false);
  assert.equal(out.instance.affect,false);assert.equal(out.instance.apperceptionV1,false);
  assert.equal(out.motivation,0);assert.equal(out.affectTurns,0);
  assert.equal(out.replyOk,true);assert.ok(out.decisions>=1);
});

test('launch with packaged runtime keeps limbic-v1 and serves a core decision',async()=>{
  const {root,env}=launchEnv({JY_AFFECT:'1',JY_AFFECT_FUSION:'1'});
  const running=await launchBrain({root,env});
  try{
    assert.equal(running.summary.affect,true);assert.equal(running.summary.fusion,true);
    assert.equal(running.summary.affectRequested,true);assert.equal(running.summary.affectDegraded,undefined);
    assert.equal(running.instance.affect,true);assert.equal(running.instance.fusion,true);
    const health=running.service.health();
    assert.equal(health.theory.enabled,true);assert.equal(health.theory.available,true);
    assert.equal(health.theory.version,'limbic-v1');assert.equal(health.theory.fusion,true);
    assert.equal(running.instance.cognition.apperceptionV1,true);
    const reply=await replyOnce(running.service);
    assert.equal(reply.ok,true,JSON.stringify(reply.error??reply));
    assert.ok([...running.service.store.all('decision')].length>=1);
    assert.ok([...running.service.store.all('motivation_state')].length>=1,'healthy affect path creates the state');
    // second input must carry the state projection through the real service loop
    const second=await replyOnce(running.service,'2','synthetic:2');
    assert.equal(second.ok,true,JSON.stringify(second.error??second));
    const decisions=[...running.service.store.all('decision')];
    assert.ok(decisions.length>=2);
    const lastInput=decisions.at(-1).input.payload.continuity;
    assert.ok(lastInput.motivation,'next decision input carries the motivation projection');
    assert.equal(lastInput.motivation.canAppraiseCurrent,true);
  }finally{await running.stop();}
});

test('runtime asset resolver agrees with bootstrap readiness path',async()=>{
  const {affectRuntimeStatus}=await import('../tools/brain-service/bootstrap.mjs');
  const asset=resolveAffectRuntimeAsset({root:process.cwd(),env:{}});
  const status=affectRuntimeStatus({root:process.cwd(),env:{}});
  assert.equal(status.pythonPath,asset.path);
  assert.equal(status.ok,asset.exists);
});