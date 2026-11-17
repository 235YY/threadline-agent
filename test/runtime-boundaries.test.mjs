import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {resolveBrainConfig,launchIdentity} from '../tools/brain-service/runtime-config.mjs';
import {claimBrainInstance} from '../tools/brain-service/instance-guard.mjs';
import {launchBrain} from '../tools/brain-service/bootstrap.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {MaintenanceSession,startMaintenanceHeartbeat} from '../src/maintenance.mjs';
import {createModelDecision} from '../src/model-transport.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {officialDashboard,officialDay} from '../src/official-dashboard.mjs';
import {keepAttention} from '../src/attention.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'jingyang-runtime-boundary-'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){const root=temp();writeFileSync(join(root,'persona.txt'),'离线合成身份');return {root,env:{BRAIN_PORT:'0',BRAIN_STATE:'state',BRAIN_STORE:':memory:',BRAIN_STYLE_DIR:'style',BRAIN_IDENTITY_FILE:'persona.txt',JY_AFFECT:'0'}};}
function fakeDependencies(extra={}){
 const calls={model:0,closed:0,serviceClosed:0,starts:[],audit:0};let options;
 const deps={officialSpend:{gate:()=>({known:true,allow:true})},auditBudgets:()=>{calls.audit++;return {within:true,unknownCalls:0,conflictCount:0};},createModelDecision:()=>{calls.model++;return {decide:()=>{throw Error('must not invoke model');},close:()=>calls.closed++};},tools:{TOOL_NAMES:[],executeTool:()=>{throw Error('external tool');}},
  core:{READ_ONLY_HOST_TOOLS:[],startBrainService:async value=>{options=value;return {server:{listening:false},port:1,url:'http://127.0.0.1:1',health:()=>({cognitionBusy:false}),close:()=>calls.serviceClosed++,stopScheduling:()=>{},startScheduling:n=>calls.starts.push(n)};}},...extra};
 return {deps,calls,options:()=>options};
}
const liveEnv=env=>({...env,BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1',JY_QQ_SCOPE:'all',BRAIN_LEDGER:'budget.json',BRAIN_MAX_CALLS:'3',BRAIN_MAX_MICROS:'100000',BRAIN_MAINTENANCE:'0'});

test('standard live startup injects the official gate and RequestJournal, without old financial or daily call halt',async()=>{
 const f=fixture(),token='o'.repeat(40),monitor=officialDashboard({file:join(f.root,'official.json'),token});
 let options,calls=0,p;const dependencies={officialSpend:monitor,auditBudgets:()=>{throw Error('legacy audit must not run');},
  tools:{TOOL_NAMES:[],executeTool:()=>{throw Error('no external tool');}},
  createModelDecision:value=>{
   options=value;const model=createModelDecision({...value,getKey:()=> 'sk-offlineabcdefghijkl',networkCheck:async()=>({ok:true}),transport:async()=>{
    calls++;const content=JSON.stringify({packetId:p.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'offline standard startup',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:10,completion_tokens:10,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10}}),{status:200});
   }});const invoke=model.decide;model.decide=(packet,context)=>{p=packet;return invoke(packet,context);};return model;
  }};
 const env={...liveEnv(f.env),BRAIN_STATE:join(f.root,'state'),BRAIN_STYLE_DIR:join(f.root,'style'),BRAIN_IDENTITY_FILE:join(f.root,'persona.txt'),BRAIN_LEDGER:join(f.root,'requests.json'),BRAIN_HEARTBEAT_MS:'0'};
 delete env.BRAIN_MAX_CALLS;delete env.BRAIN_MAX_MICROS;
 const brain=await launchBrain({root:process.cwd(),env,dependencies});
 try{
  assert.ok(options.requestJournal instanceof RequestJournal);assert.equal(options.officialSpend,monitor);assert.equal(brain.config.rhythm.dailyCallCap,null);
  const paused=await brain.service.reply({source:'fixture',key:'paused',scene:'synthetic',message_id:'one',messages:[{role:'user',content:'offline message'}]});
  assert.equal(paused.silent,true);assert.equal((await brain.service.turn()).budgetPaused,true);assert.equal(calls,0);
  const now=Date.now();monitor.accept({source:'https://platform.deepseek.com/usage',keyLabel:'新版鲸漾系统',period:'today',timeZone:'Asia/Shanghai',currency:'CNY',day:officialDay(now),spendMicros:1000,requestCount:0,capturedAt:now},token);
  await brain.service.turn();assert.equal(calls,1);assert.equal(options.requestJournal.data.requests[0].validation.status,'accepted');
 }finally{await brain.stop();}
});

test('dry defaults use isolated storage and cannot enable live model or QQ implicitly',()=>{
 const root=temp(),c=resolveBrainConfig({root,env:{}});
 assert.equal(c.live,false);assert.equal(c.storePath,resolve(root,'_local/dry-run/subject.sqlite'));assert.equal(c.heartbeatMs,0);assert.equal(c.maintenance,false);assert.equal(c.ledgerPath,null);
});

for(const [key,value] of [['BRAIN_PORT','NaN'],['BRAIN_MAX_CALLS','-1'],['BRAIN_HEARTBEAT_MS',''],['BRAIN_STORE',''],['JY_APPERCEPTION_V1','yes']])test(`invalid ${key} fails before claiming state or loading a model`,async()=>{
 const f=fixture(),fake=fakeDependencies();await assert.rejects(launchBrain({...f,env:{...f.env,[key]:value},dependencies:fake.deps}),{code:'RUNTIME_CONFIG'});
 assert.equal(fake.calls.model,0);assert.equal(existsSync(join(f.root,'state')),false);
});

test('live requires explicit confirmation and request journal path before any state write',async()=>{
 for(const missing of ['JY_LIVE_CONFIRM','BRAIN_LEDGER']){
  const f=fixture(),env=liveEnv(f.env),fake=fakeDependencies();delete env[missing];await assert.rejects(launchBrain({...f,env,dependencies:fake.deps}));assert.equal(fake.calls.audit,0);assert.equal(fake.calls.model,0);assert.equal(existsSync(join(f.root,'state')),false);
 }
});

test('foreign request journal lock is retained; legacy financial audit is not a second authority',async()=>{
 const f=fixture(),foreign=join(f.root,'budget.json.lock');writeFileSync(foreign,'foreign-owner');const fake=fakeDependencies({auditBudgets:()=>({within:false,unknownCalls:1})});
 await assert.rejects(launchBrain({...f,env:liveEnv(f.env),dependencies:fake.deps}),{code:'EEXIST'});
 assert.equal(readFileSync(foreign,'utf8'),'foreign-owner');assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);assert.equal(fake.calls.model,0);assert.equal(fake.calls.audit,0);
});

test('invalid or oversized identity is rejected without silent truncation',async()=>{
 const f=fixture(),fake=fakeDependencies();writeFileSync(join(f.root,'persona.txt'),'鲸'.repeat(4001));
 await assert.rejects(launchBrain({...f,dependencies:fake.deps}),{code:'IDENTITY_BUDGET'});
 assert.equal(readFileSync(join(f.root,'persona.txt'),'utf8').length,4001);assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);
 assert.equal(fake.calls.model,0);assert.equal(existsSync(join(f.root,'state','brain.launch.lock')),false);
});

test('blank identity is not replaced by a generic identity',()=>{
 const f=fixture();writeFileSync(join(f.root,'persona.txt'),'  ');assert.throws(()=>launchIdentity(resolveBrainConfig(f),{explicit:true}),{code:'IDENTITY_EMPTY'});
});

test('instance is only published after service readiness and live failure closes owned model',async()=>{
 const f=fixture(),fake=fakeDependencies({core:{READ_ONLY_HOST_TOOLS:[],startBrainService:async()=>{assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);throw Object.assign(Error('listen failed'),{code:'EADDRINUSE'});}}});
 await assert.rejects(launchBrain({...f,env:liveEnv(f.env),dependencies:fake.deps}),{code:'EADDRINUSE'});
 assert.equal(fake.calls.model,1);assert.equal(fake.calls.closed,1);assert.equal(readdirSync(join(f.root,'state')).length,0);
});

test('foreign launch locks and stale metadata remain evidence rather than being stolen',()=>{
 const root=temp();writeFileSync(join(root,'brain.launch.lock'),'foreign');assert.throws(()=>claimBrainInstance({stateDirectory:root}),{code:'INSTANCE_LOCKED'});assert.equal(readFileSync(join(root,'brain.launch.lock'),'utf8'),'foreign');
 const stale=temp();writeFileSync(join(stale,'brain-service.pid'),'123');assert.throws(()=>claimBrainInstance({stateDirectory:stale,isAlive:()=>false}),{code:'INSTANCE_RECOVERY_REQUIRED'});assert.equal(readFileSync(join(stale,'brain-service.pid'),'utf8'),'123');
});

test('instance cleanup never removes a replacement instance owned by somebody else',()=>{
 const root=temp(),guard=claimBrainInstance({stateDirectory:root});guard.publish({mode:'dry-run'});
 writeFileSync(guard.lock,JSON.stringify({instanceId:'replacement'}));writeFileSync(guard.instanceFile,JSON.stringify({instanceId:'replacement'}));guard.close();
 assert.equal(JSON.parse(readFileSync(guard.instanceFile,'utf8')).instanceId,'replacement');assert.equal(existsSync(guard.lock),true);
});

test('dry startup does not construct a model or wire an external sender',async()=>{
 const f=fixture(),fake=fakeDependencies(),running=await launchBrain({...f,dependencies:fake.deps});
 try{assert.equal(fake.calls.model,0);assert.equal(fake.calls.audit,0);assert.deepEqual(fake.options().agentTools,{});assert.deepEqual(fake.options().allowedActionTools,[]);assert.equal((await fake.options().adapter.send({scene:'qq/private/fixture',text:'x'})).delivered,false);
  const instance=JSON.parse(readFileSync(join(f.root,'state','brain.instance.json'),'utf8'));assert.equal(instance.status,'ready');assert.equal(instance.configFingerprint,running.summary.configFingerprint);
 }finally{await running.stop();}assert.equal(readdirSync(join(f.root,'state')).length,0);
});

test('effective cognition flags are explicit and fingerprints change with behavior',async()=>{
 const f=fixture(),a=resolveBrainConfig(f),b=resolveBrainConfig({...f,env:{...f.env,JY_APPERCEPTION_V1:'1'}});assert.notEqual(a.configFingerprint,b.configFingerprint);assert.equal(b.cognition.apperceptionV1,true);
 assert.throws(()=>{b.cognition.apperceptionV1=false;},TypeError);
 const fake=fakeDependencies(),running=await launchBrain({...f,env:{...f.env,JY_APPERCEPTION_V1:'1'},dependencies:fake.deps});try{assert.equal(fake.options().cognition.apperceptionV1,true);assert.equal(fake.options().runtimeInfo.cognition.apperceptionV1,true);}finally{await running.stop();}
});

test('incompatible memory generations and fusion without an engine fail explicitly',()=>{
 const f=fixture();assert.throws(()=>resolveBrainConfig({...f,env:{...f.env,JY_SUBJECTIVE_MEMORY:'1',JY_SUBJECTIVE_MEMORY_V2:'1'}}),{code:'RUNTIME_CONFIG'});
 assert.throws(()=>resolveBrainConfig({...f,env:{...f.env,JY_AFFECT_FUSION:'1'}}),{code:'RUNTIME_CONFIG'});
});

test('source changes during startup prevent a false ready record',async()=>{
 const f=fixture();mkdirSync(join(f.root,'src'));writeFileSync(join(f.root,'src','fixture.mjs'),'export const x=1;');const fake=fakeDependencies();const start=fake.deps.core.startBrainService;
 fake.deps.core.startBrainService=async options=>{const value=await start(options);writeFileSync(join(f.root,'src','fixture.mjs'),'export const x=2;');return value;};
 await assert.rejects(launchBrain({...f,dependencies:fake.deps}),{code:'SOURCE_CHANGED_DURING_BOOT'});assert.equal(fake.calls.serviceClosed,1);assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);
});

test('real isolated dry service reports the configuration it actually uses',async()=>{
 const f=fixture(),running=await launchBrain({root:process.cwd(),env:{...f.env,BRAIN_STATE:join(f.root,'state'),BRAIN_STYLE_DIR:join(f.root,'style'),BRAIN_IDENTITY_FILE:join(f.root,'persona.txt'),JY_APPERCEPTION_V1:'1'}});
 try{const h=running.service.health();assert.equal(h.runtime.mode,'dry-run');assert.equal(h.runtime.configFingerprint,running.summary.configFingerprint);assert.equal(h.runtime.cognition.apperceptionV1,true);assert.equal(h.scheduling.enabled,false);
 }finally{await running.stop();}
});

test('port binding failure is catchable and leaves no false ready metadata',async()=>{
 const f=fixture(),server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{await assert.rejects(launchBrain({root:process.cwd(),env:{...f.env,BRAIN_PORT:String(server.address().port),BRAIN_STATE:join(f.root,'state'),BRAIN_STYLE_DIR:join(f.root,'style'),BRAIN_IDENTITY_FILE:join(f.root,'persona.txt')}}),{code:'EADDRINUSE'});assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);assert.equal(existsSync(join(f.root,'state','brain.launch.lock')),false);
 }finally{await new Promise(r=>server.close(r));}
});

test('maintenance and task cognition share the same exclusive opportunity',async t=>{
 const s=createBrainService({global:true,subjectTask:true,heartbeatMs:0});t.after(()=>s.close());const started=deferred(),release=deferred();
 const pending=s.runCognitionExclusive(async()=>{started.resolve();await release.promise;return {status:'adopted'};});await started.promise;
 assert.equal(s.health().cognitionBusy,true);assert.equal((await s.agentTick()).skipped,true);assert.equal((await s.turn()).busy,true);assert.equal((await s.runCognitionExclusive(()=>{throw Error('must not run');})).status,'busy');
 release.resolve();assert.equal((await pending).status,'adopted');assert.equal(s.health().cognitionBusy,false);
 await assert.rejects(s.runCognitionExclusive(()=>{throw Error('failure');}));assert.equal(s.health().cognitionBusy,false);
});

test('ambient feature variables cannot silently change a core service',async()=>{
 const old=process.env.JY_APPERCEPTION_V1;process.env.JY_APPERCEPTION_V1='1';let packet;
 const s=createBrainService({global:true,heartbeatMs:0,decide:p=>{packet=p;return {packetId:p.packetId,options:[{id:'x',kind:'wait',payload:{}}],selected:'x',summary:'synthetic',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};}});
 try{s.observe({source:'qq',key:'private:fixture',sourceKey:'ambient-test',text:'合成输入'});await s.turn();assert.equal(packet.payload.apperceptionV1,undefined);}finally{s.close();if(old===undefined)delete process.env.JY_APPERCEPTION_V1;else process.env.JY_APPERCEPTION_V1=old;}
});

test('affect availability is probed before model construction, without publishing false readiness',async()=>{
 const f=fixture(),fake=fakeDependencies({affect:{probeAffect:async()=>{throw Object.assign(Error('worker missing'),{code:'WORKER_UNAVAILABLE'});},affectFactory:()=>{throw Error('must not construct session');}}});
 await assert.rejects(launchBrain({...f,env:{...liveEnv(f.env),JY_AFFECT:'1'},dependencies:fake.deps}),{code:'WORKER_UNAVAILABLE'});
 assert.equal(fake.calls.model,0);assert.equal(existsSync(join(f.root,'state','brain.instance.json')),false);assert.equal(existsSync(join(f.root,'state','brain.launch.lock')),false);
});

test('real local affect probe and fusion configuration start without calling a model',async()=>{
 const f=fixture(),running=await launchBrain({root:process.cwd(),env:{...f.env,JY_AFFECT:'1',JY_AFFECT_FUSION:'1',BRAIN_STATE:join(f.root,'state'),BRAIN_STYLE_DIR:join(f.root,'style'),BRAIN_IDENTITY_FILE:join(f.root,'persona.txt')}});
 try{const h=running.service.health();assert.equal(h.theory.available,true);assert.equal(h.runtime.affect.fusion,true);assert.equal(h.runtime.cognition.apperceptionV1,true);assert.equal(running.summary.maintenance,false);}finally{await running.stop();}
});

test('shutdown refuses to abandon in-flight work and retains ownership until a later clean stop',async()=>{
 const f=fixture(),fake=fakeDependencies();let busy=true;const start=fake.deps.core.startBrainService;fake.deps.core.startBrainService=async o=>({...await start(o),health:()=>({cognitionBusy:busy})});
 const running=await launchBrain({...f,dependencies:fake.deps});await assert.rejects(running.stop(),{code:'SHUTDOWN_BUSY'});assert.equal(existsSync(join(f.root,'state','brain.launch.lock')),true);assert.equal(fake.calls.serviceClosed,0);
 busy=false;await running.stop();assert.equal(existsSync(join(f.root,'state','brain.launch.lock')),false);
});

test('stopping scheduling invalidates an in-flight timer chain before it schedules more cognitive work',async()=>{
 const entered=deferred(),release=deferred();let calls=0;
 const s=createBrainService({global:true,subjectTask:true,heartbeatMs:0,idleIntervalMs:0,decide:async p=>{calls++;entered.resolve();await release.promise;return {packetId:p.packetId,options:[{id:'x',kind:'act',payload:{tool:'task_finish',args:{result:'done'}}}],selected:'x',summary:'synthetic',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};}});
 try{await s.createAgentTask({goal:'timer test'});s.startScheduling(5);await entered.promise;s.stopScheduling();release.resolve();await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);assert.equal(s.health().scheduling.enabled,false);assert.equal(s.health().cognitionBusy,false);}finally{release.resolve();s.close();}
});

test('maintenance heartbeat uses the host exclusion gate before preparing a job',async t=>{
 const s=createBrainService({heartbeatMs:0});t.after(()=>s.close());let gates=0,models=0,result;
 const session=new MaintenanceSession({store:s.store,subjectId:'jingyang'}),h=startMaintenanceHeartbeat({session,isBusy:()=>false,runExclusive:async fn=>{gates++;assert.equal(typeof fn,'function');return {status:'busy',modelCalled:false};},invoke:()=>models++,authorize:async()=>true,onResult:r=>result=r});
 try{await h.tick();assert.equal(gates,1);assert.equal(models,0);assert.equal(result.status,'busy');assert.equal([...s.store.all('maintenance_job')].length,0);}finally{h.stop();}
});

test('live launch refuses to silently create a subject or journal, or to open every QQ chat',async()=>{
 const {launchBrain}=await import('../tools/brain-service/bootstrap.mjs');
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const d=mkdtempSync(join(tmpdir(),'jy-live-ack-')),env={BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',JY_AFFECT:'0',BRAIN_PORT:'0',BRAIN_STORE:join(d,'s.sqlite'),BRAIN_STATE:join(d,'state'),BRAIN_LEDGER:join(d,'j.json'),BRAIN_IDENTITY_FILE:new URL('../config/identity.example.txt',import.meta.url).pathname,JY_OFFICIAL_USAGE_TOKEN:'x'.repeat(32)};
 const root=new URL('../',import.meta.url).pathname;
 await assert.rejects(launchBrain({root,env}),{code:'NEW_SUBJECT_UNCONFIRMED'});
 await assert.rejects(launchBrain({root,env:{...env,JY_NEW_SUBJECT:'1'}}),{code:'NEW_JOURNAL_UNCONFIRMED'});
 await assert.rejects(launchBrain({root,env:{...env,JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1'}}),{code:'QQ_SCOPE_UNCONFIRMED'});
 const {readdirSync}=await import('node:fs');assert.deepEqual(readdirSync(d),[]);
});

test('runtime build identity is the same for LF and CRLF checkouts, and still detects real edits',async()=>{
 const {runtimeSourceIdentity,SOURCE_IDENTITY_RULE}=await import('../tools/brain-service/instance-guard.mjs');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const tree=eol=>{const r=mkdtempSync(join(tmpdir(),'jy-build-'));mkdirSync(join(r,'src'));mkdirSync(join(r,'prompts'));
  writeFileSync(join(r,'src','a.mjs'),['export const a=1;','// 注释',''].join(eol));writeFileSync(join(r,'prompts','p.zh.md'),['第一行','第二行'].join(eol));return r;};
 const lf=runtimeSourceIdentity(tree('\n')),crlf=runtimeSourceIdentity(tree('\r\n'));
 assert.equal(lf.rule,SOURCE_IDENTITY_RULE);assert.equal(lf.fingerprint,crlf.fingerprint);
 const edited=tree('\n');writeFileSync(join(edited,'src','a.mjs'),'export const a=2;\n// 注释\n');
 assert.notEqual(runtimeSourceIdentity(edited).fingerprint,lf.fingerprint);
});
