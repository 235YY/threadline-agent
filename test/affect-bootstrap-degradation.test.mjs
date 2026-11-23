// A-owned bootstrap-level Limbic degradation tests: off / probe-unavailable / available
// / missing packaged runtime + packaged-runtime path+provenance validation.
// Synthetic only: no model, no QQ, no production database; fake affect adapter and
// fake core capture the host options passed to startBrainService.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {launchBrain,affectRuntimeStatus} from '../tools/brain-service/bootstrap.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {callWorker} from '../tools/affect-shadow/bridge.mjs';
import {keepAttention} from '../src/attention.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function tempRoot(t){const dir=mkdtempSync(join(tmpdir(),'jy-affect-boot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeCore(captured,diagnostics){
 return {READ_ONLY_HOST_TOOLS:[],async startBrainService(options){
  captured.options=options;
  return {server:{listening:false},port:0,url:'http://offline',token:null,
   store:{recordDiagnostic:value=>{diagnostics.push(value);return {logged:true};},read:()=>null,all:()=>[]},
   health:()=>({cognitionBusy:false,active:null,pending:[]}),close(){},stopScheduling(){},beginShutdown(){},startScheduling(){},runCognitionExclusive:async fn=>fn()};
 }};
}
function baseEnv(root){return {BRAIN_STORE:join(root,'subject.sqlite'),BRAIN_STATE:join(root,'state'),BRAIN_STYLE_DIR:join(root,'style')};}
async function boot(t,{env,affect,root=process.cwd()}){
 const state=tempRoot(t),captured={},diagnostics=[];
 const running=await launchBrain({root,env:{...baseEnv(state),...env},
  dependencies:{core:fakeCore(captured,diagnostics),...(affect?{affect}: {})}});
 t.after(async()=>{try{await running.stop();}catch{}});
 return {running,captured,diagnostics,state};
}

test('affect off does not touch the affect adapter and keeps theory disabled',async t=>{
 let probed=0;
 const {running,captured,diagnostics}=await boot(t,{env:{JY_AFFECT:'0'},affect:{probeAffect:async()=>{probed++;},probeAffectSafe:async()=>{probed++;return {available:true};},affectFactory:()=>({})}});
 assert.equal(probed,0);
 assert.equal(captured.options.sessionFactory??null,null);
 assert.deepEqual(captured.options.theoryStatus(),{enabled:false,available:false,version:null});
 assert.equal(running.summary.affect,false);
 assert.equal(running.summary.fusion,false);
 assert.equal(running.instance.affect,false);
 assert.equal(diagnostics.length,0);
});

test('JY_AFFECT=1 with unavailable probe starts degraded and keeps core running',async t=>{
 const verify=[];
 const {running,captured,diagnostics}=await boot(t,{env:{JY_AFFECT:'1'},affect:{
  probeAffectSafe:async()=>({available:false,degraded:true,code:'WORKER_UNAVAILABLE',message:'synthetic runtime missing'}),
  affectFactory:()=>({fakeSession:true}),
  verifyStoredAffect:()=>{verify.push(1);}}});
 assert.equal(captured.options.sessionFactory??null,null,'degraded run must not install an affect session factory');
 const theory=captured.options.theoryStatus();
 assert.equal(theory.enabled,false);assert.equal(theory.available,false);assert.equal(theory.degraded,true);assert.equal(theory.code,'WORKER_UNAVAILABLE');
 assert.equal(running.summary.affect,false);assert.equal(running.summary.fusion,false);assert.equal(running.summary.affectRequested,true);
 assert.deepEqual(running.summary.affectDegraded,{code:'WORKER_UNAVAILABLE',source:'packaged'});
 assert.equal(running.instance.affect,false);assert.equal(running.instance.fusion,false);
 assert.equal(verify.length,0,'degraded run must not verify/enter stored affect state');
 assert.ok(diagnostics.some(d=>d.stage==='affect.degraded'&&d.status==='degraded'&&d.data.reason==='WORKER_UNAVAILABLE'));
 assert.equal(captured.options.runtimeInfo.affect.requested,true);
 assert.equal(captured.options.runtimeInfo.affect.degraded,true);
 assert.equal(captured.options.runtimeInfo.affect.source,'packaged');
 assert.equal(captured.options.runtimeInfo.affect.provenance.status,'verified');
});

test('missing packaged runtime degrades before the probe (production-like absent runtime)',async t=>{
 const root=tempRoot(t);let probed=0;
 const state=tempRoot(t),captured={},diagnostics=[];
 const running=await launchBrain({root,env:{...baseEnv(state),JY_AFFECT:'1'},dependencies:{core:fakeCore(captured,diagnostics),affect:{probeAffectSafe:async()=>{probed++;return {available:true};},affectFactory:()=>({})}}});
 t.after(async()=>{try{await running.stop();}catch{}});
 assert.equal(probed,0,'probe must not run when the packaged runtime is absent');
 assert.equal(running.summary.affectDegraded.code,'AFFECT_RUNTIME_MISSING');
 assert.equal(captured.options.theoryStatus().degraded,true);
 assert.equal(captured.options.runtimeInfo.affect.source,'packaged');
 assert.equal(captured.options.runtimeInfo.affect.provenance.status,'unavailable');
 assert.equal(captured.options.runtimeInfo.affect.provenance.code,'AFFECT_RUNTIME_MISSING');
 assert.ok(diagnostics.some(d=>d.stage==='affect.degraded'&&d.data.reason==='AFFECT_RUNTIME_MISSING'));
});

test('probe-unavailable via legacy probeAffect also degrades (compatibility path)',async t=>{
 const {captured,diagnostics}=await boot(t,{env:{JY_AFFECT:'1'},affect:{probeAffect:async()=>{throw Object.assign(Error('missing worker'),{code:'WORKER_UNAVAILABLE'});},affectFactory:()=>({})}});
 assert.equal(captured.options.sessionFactory??null,null);
 assert.equal(captured.options.theoryStatus().degraded,true);
 assert.ok(diagnostics.some(d=>d.stage==='affect.degraded'));
});

test('fusion-only apperception is reverted when fusion degrades; explicit flag is kept',async t=>{
 const base={probeAffectSafe:async()=>({available:false,degraded:true,code:'WORKER_UNAVAILABLE'}),affectFactory:()=>({})};
 const first=await boot(t,{env:{JY_AFFECT:'1',JY_AFFECT_FUSION:'1'},affect:base});
 assert.equal(first.captured.options.cognition.apperceptionV1,false,'fusion-forced apperception must not outlive a degraded fusion');
 const second=await boot(t,{env:{JY_AFFECT:'1',JY_AFFECT_FUSION:'1',JY_APPERCEPTION_V1:'1'},affect:base});
 assert.equal(second.captured.options.cognition.apperceptionV1,true,'explicit apperception flag is independent of fusion');
});

test('available affect keeps limbic-v1 theory and installs the affect session factory',async t=>{
 const verify=[];const sessionFactory=function(){return {};};
 const {running,captured,diagnostics}=await boot(t,{env:{JY_AFFECT:'1',JY_AFFECT_FUSION:'1'},affect:{
  probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:true}),
  planAffectRuntime:({affect,probe})=>{assert.equal(probe.available,true);assert.equal(affect.fusion,true);return {enabled:true,fusion:true,sessionFactory,degraded:false};},
  affectFactory:()=>sessionFactory,
  verifyStoredAffect:()=>{verify.push(1);}}});
 assert.equal(typeof captured.options.sessionFactory,'function');
 const theory=captured.options.theoryStatus();
 assert.equal(theory.enabled,true);assert.equal(theory.available,true);assert.equal(theory.version,'limbic-v1');assert.equal(theory.fusion,true);
 assert.equal(running.summary.affect,true);assert.equal(running.summary.fusion,true);
 assert.equal(running.summary.affectDegraded,undefined);
 assert.equal(verify.length,1);
 assert.equal(diagnostics.some(d=>d.stage==='affect.degraded'),false);
});

test('fusion unsupported by an available affect runtime falls back to non-fusion affect',async t=>{
 const sessionFactory=function(){return {};};
 const {running,captured}=await boot(t,{env:{JY_AFFECT:'1',JY_AFFECT_FUSION:'1'},affect:{
  probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:false}),
  planAffectRuntime:()=>({enabled:true,fusion:false,degraded:false,fusionFallback:true,fusionReason:'FUSION_UNSUPPORTED',sessionFactory}),
  affectFactory:()=>sessionFactory,verifyStoredAffect:()=>{}}});
 assert.equal(running.summary.affect,true);assert.equal(running.summary.fusion,false);
 assert.equal(captured.options.cognition.apperceptionV1,false,'implicit fusion apperception must follow the effective fusion state');
 const theory=captured.options.theoryStatus();
 assert.equal(theory.enabled,true);assert.equal(theory.fusion,false);
});

test('live startup with missing affect runtime degrades instead of refusing (production shape)',async t=>{
 const root=tempRoot(t),state=tempRoot(t);let probed=0;
 writeFileSync(join(root,'persona.txt'),'离线合成身份');
 const captured={},diagnostics=[];
 const running=await launchBrain({root,env:{BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1',JY_QQ_SCOPE:'all',
  BRAIN_STORE:':memory:',BRAIN_LEDGER:join(root,'journal.json'),BRAIN_PORT:'0',BRAIN_STATE:join(state,'state'),BRAIN_STYLE_DIR:join(state,'style'),
  BRAIN_IDENTITY_FILE:join(root,'persona.txt'),BRAIN_MAINTENANCE:'0',BRAIN_HEARTBEAT_MS:'0',JY_AFFECT:'1'},
  dependencies:{core:fakeCore(captured,diagnostics),
   officialSpend:{gate:()=>({known:true,allow:true})},
   createModelDecision:()=>({decide(){throw Error('NO_MODEL');},close(){}}),
   tools:{TOOL_NAMES:[],UNAVAILABLE_TOOLS:[],executeTool:async()=>{throw Error('NO_EXTERNAL');}},
   requestJournal:{packetRequest:()=>null,data:{requests:[]},close(){}},
   affect:{probeAffectSafe:async()=>{probed++;return {available:true};},affectFactory:()=>({})}}});
 t.after(async()=>{try{await running.stop();}catch{}});
 assert.equal(probed,0);
 assert.equal(running.summary.affect,false);
 assert.equal(running.summary.affectDegraded.code,'AFFECT_RUNTIME_MISSING');
 assert.equal(captured.options.theoryStatus().degraded,true);
 assert.equal(captured.options.runtimeInfo.affect.source,'packaged');
 assert.equal(captured.options.runtimeInfo.affect.provenance.status,'unavailable');
 assert.equal(captured.options.runtimeInfo.affect.provenance.code,'AFFECT_RUNTIME_MISSING');
 assert.equal(running.instance.mode,'live');assert.equal(running.instance.affect,false);
 assert.ok(diagnostics.some(d=>d.stage==='affect.degraded'));
});

test('runtime loss after ready is visible through theoryStatus without restarting',async t=>{
 const factory=args=>{args.onDegraded?.({reason:'WORKER_UNAVAILABLE',phase:'preview'});return function(){return {};};};
 const {captured}=await boot(t,{env:{JY_AFFECT:'1'},affect:{
  probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:true}),
  planAffectRuntime:()=>({enabled:true,fusion:false,degraded:false,sessionFactory:factory}),
  affectFactory:()=>factory,verifyStoredAffect:()=>{}}});
 captured.options.sessionFactory({});
 const theory=captured.options.theoryStatus();
 assert.equal(theory.enabled,false);assert.equal(theory.available,false);assert.equal(theory.degraded,true);
 assert.equal(theory.code,'WORKER_UNAVAILABLE');assert.equal(theory.runtimeDegraded,true);
});

test('real affect runtime loss after ready: core turns continue through the session fallback',async t=>{
 const runtime=affectRuntimeStatus({root:process.cwd(),env:{}});
 if(!runtime.ok){t.skip('packaged affect runtime unavailable in this checkout');return;}
 let transition=0;
 const worker=async input=>{
  if(input.action==='transition'){transition+=1;if(transition>=2)throw Object.assign(Error('synthetic worker loss'),{code:'WORKER_UNAVAILABLE'});}
  return callWorker(input);
 };
 const factory=args=>new AffectSession({...args,worker});
 const decide=packet=>({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'ok'}}],selected:'r',summary:'synthetic',used:[],
  continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
 const service=await startBrainService({port:0,storePath:':memory:',heartbeatMs:0,global:false,sessionFactory:factory,decide,identity:'离线合成主体'});
 t.after(async()=>{try{await new Promise(resolve=>service.server.close(resolve));}catch{}service.close();});
 const say=id=>service.reply({scene:'qq/private/1',key:'private:1',source:'qq',message_id:id,execute:false,messages:[{role:'user',content:'synthetic '+id}]});
 const replies=[];
 for(const id of ['m1','m2','m3']){replies.push(await say(id));}
 assert.equal(replies.length,3);
 for(const reply of replies)assert.equal(reply.ok,true,'core turn must survive affect worker loss');
 assert.equal(replies.at(-1).text,'ok');
 assert.ok([...service.store.all('decision')].length>=3,'decisions continue after the worker disappears');
 assert.ok([...service.store.all('affect_turn')].some(turn=>turn.status==='failed'),'lost runtime is recorded as a failed affect turn');
 assert.equal(service.health().cognitionBusy,false);
});

test('available affect exposes packaged provenance in runtimeInfo.affect (M3 gate)',async t=>{
 const sessionFactory=function(){return {};};
 const {captured}=await boot(t,{env:{JY_AFFECT:'1'},affect:{
  probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:true}),
  planAffectRuntime:()=>({enabled:true,fusion:false,degraded:false,sessionFactory}),
  affectFactory:()=>sessionFactory,verifyStoredAffect:()=>{}}});
 const runtime=captured.options.runtimeInfo.affect;
 assert.equal(runtime.enabled,true);assert.equal(runtime.source,'packaged');
 assert.equal(runtime.provenance.status,'verified');assert.equal(runtime.provenance.version,'3.13.9');
 assert.equal(runtime.provenance.signatureStatus,'Valid');assert.equal(runtime.provenance.archive,'verified');
});

test('operator-provided runtime provenance is explicitly unverified in health',async t=>{
 const state=tempRoot(t),python=join(state,'operator-python.exe');writeFileSync(python,'synthetic interpreter');
 const sessionFactory=function(){return {};};
 const {captured}=await boot(t,{env:{JY_AFFECT:'1',JY_AFFECT_PYTHON:python},affect:{
  probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:true}),
  planAffectRuntime:()=>({enabled:true,fusion:false,degraded:false,sessionFactory}),
  affectFactory:()=>sessionFactory,verifyStoredAffect:()=>{}}});
 const runtime=captured.options.runtimeInfo.affect;
 assert.equal(runtime.enabled,true);assert.equal(runtime.source,'operator');
 assert.deepEqual(runtime.provenance,{status:'unverified',origin:'operator-provided'});
});

test('an invalid affect plan is an internal contract error, not an environment degradation',async t=>{
 const state=tempRoot(t),captured={},diagnostics=[];
 await assert.rejects(()=>launchBrain({root:process.cwd(),env:{...baseEnv(state),JY_AFFECT:'1'},
  dependencies:{core:fakeCore(captured,diagnostics),affect:{
   probeAffectSafe:async()=>({available:true,degraded:false,upstream:'synthetic',profileHash:sha('profile'),fusionSupported:true}),
   planAffectRuntime:()=>({enabled:true,fusion:false,degraded:false})}}}),{code:'AFFECT_PLAN_INVALID'});
 assert.equal(captured.options??null,null,'no service is constructed for an invalid plan');
 assert.equal(existsSync(join(state,'brain.instance.json')),false);
 assert.equal(existsSync(join(state,'brain.launch.lock')),false);
 assert.equal(diagnostics.length,0);
});

test('packaged runtime provenance verifies and tampering is rejected',t=>{
 const root=tempRoot(t),dir=join(root,'_local','affect-runtime'),bin=join(dir,'python-3.13.9');
 mkdirSync(bin,{recursive:true});
 const exe=Buffer.from('synthetic interpreter placeholder');writeFileSync(join(bin,'python.exe'),exe);
 const archive=Buffer.from('synthetic archive placeholder');writeFileSync(join(dir,'python-3.13.9-embed-amd64.zip'),archive);
 const provenance={source:'https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip',version:'3.13.9',archiveSha256:sha(archive),exeSha256:sha(exe),signatureStatus:'Valid',installedGlobally:false,pathChanged:false};
 writeFileSync(join(dir,'PROVENANCE.json'),JSON.stringify(provenance));
 const ok=affectRuntimeStatus({root,env:{}});
 assert.equal(ok.ok,true);assert.equal(ok.code,'AFFECT_RUNTIME_VERIFIED');assert.equal(ok.provenance.archive,'verified');
 const missing=affectRuntimeStatus({root:tempRoot(t),env:{}});
 assert.equal(missing.ok,false);assert.equal(missing.code,'AFFECT_RUNTIME_MISSING');
 writeFileSync(join(bin,'python.exe'),Buffer.from('tampered'));
 assert.equal(affectRuntimeStatus({root,env:{}}).code,'AFFECT_PROVENANCE_MISMATCH');
 const override=join(root,'operator-python.exe');writeFileSync(override,'operator interpreter');
 const provided=affectRuntimeStatus({root,env:{JY_AFFECT_PYTHON:override}});
 assert.equal(provided.ok,true);assert.equal(provided.code,'AFFECT_RUNTIME_OPERATOR_PROVIDED');assert.equal(provided.provenance,'unverified');
});
