import {localE5Encoder,localMemoryReranker,SemanticMemory} from '../../src/memory-semantic.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from '../../src/contracts.mjs';
import {resolveBrainConfig,launchIdentity,assertSupportedNode} from './runtime-config.mjs';
import {claimBrainInstance,runtimeSourceIdentity} from './instance-guard.mjs';
import {withTypedStateContract} from './typed-state-contract.mjs';
import {officialDashboard,officialDay} from '../../src/official-dashboard.mjs';
import {attentionId} from '../../src/attention.mjs';
import {RequestJournal} from '../../src/request-journal.mjs';

// ---- U6 deliveryPin: host-owned target authority (no new persisted fields) ----
// A pin is derived only from records that already exist (response.scene, decision.input,
// action.inputRefs, task origin refs). A missing derivation is a known unexecuted
// failure, never a silent allow. These helpers are exported for tests and for the
// Lead-owned claim/attention hooks that cannot be edited from the A file scope.
export const DELIVERY_SEND_TOOLS=Object.freeze(['qq_send_message','qq_send_private_message','qq_send_group_message','qq_send_sticker','qq_send_image','qq_send_voice','qq_send_poke','proactive_contact']);
const QQ_DELIVERY_SCENE=/^qq\/(private|group)\/\d+$/;
const deliveryReject=(code,message)=>Object.assign(new Error(message),{code,transportInvoked:false,nativePreflight:false});
const qqScene=value=>typeof value==='string'&&QQ_DELIVERY_SCENE.test(value)?value:null;
const uniqueStrings=value=>[...new Set((Array.isArray(value)?value:[]).filter(item=>typeof item==='string'&&item.length>0))];
export function splitQQTarget(scene){const match=/^qq\/(private|group)\/(\d+)$/.exec(String(scene??''));return match?{target:match[1],id:match[2]}:null;}
// IR-02 inbound scene policy: derived only from existing deployment variables; no
// new config key and no state. The Lead-owned server route checks this before observe.
export function inboundScenePolicy({env=process.env}={}){
 const rawOwner=env.QQ_OWNER??env.QQ_TEST_ONLY_OWNER??null;
 const ownerQQ=typeof rawOwner==='string'&&/^\d+$/.test(rawOwner.trim())?rawOwner.trim():null;
 const allowedGroups=[...new Set(String(env.QQ_ALLOWED_GROUPS??'').split(',').map(value=>value.trim()).filter(value=>/^\d+$/.test(value)))];
 // M5 user requirement C: friends' private chats stay visible when the connector
 // itself is in all-scope mode; no new env key and the group whitelist is unchanged.
 return {mode:'enforce',ownerQQ,allowedGroups,groupIngest:env.JY_GROUP_INGEST==='off'?'off':'on',requireToken:env.JY_REQUIRE_BRAIN_TOKEN==='1',allowAllPrivate:env.QQ_CHAT_SCOPE==='all'};
}
export function sendTargetScene(tool,args={}){
 if(!DELIVERY_SEND_TOOLS.includes(tool))return null;
 // proactive_contact carries its explicit target as a persisted qq scene, not target/id.
 if(tool==='proactive_contact')return qqScene(args?.targetScene);
 const target=args?.target??(args?.group_id?'group':args?.user_id?'private':null);
 const id=args?.id??args?.group_id??args?.user_id;
 return qqScene(target&&/^\d+$/.test(String(id??''))?`qq/${target}/${id}`:null);
}
function decisionInputTargets(input,{includeContactTargets=false}={}){
 const out=new Set(),current=input?.payload?.current;
 if(current?.scene&&qqScene(current.scene))out.add(current.scene);
 if(includeContactTargets)for(const target of input?.payload?.continuity?.contactTargets??[])if(qqScene(target?.scene))out.add(target.scene);
 const followup=input?.payload?.followup?.targetScene;if(qqScene(followup))out.add(followup);
 return [...out];
}
function readOwnRecord(store,ref,type,subjectId){
 ensure(store&&typeof store.read==='function','DELIVERY_PIN','host store required');
 const record=ref&&typeof ref.id==='string'?(Number.isSafeInteger(ref.revision)?store.read(ref.id,ref.revision):store.read(ref.id)):null;
 ensure(record?.type===type,`DELIVERY_PIN_UNAVAILABLE`,'persisted '+type+' required');
 if(record.subject&&record.subject!==subjectId)ensure(false,'DELIVERY_PIN_UNAVAILABLE','delivery source belongs to another subject');
 return record;
}
export function deliveryPinForResponse({store,subjectId='jingyang',response}){
 ensure(response?.id,'RESPONSE_REQUIRED','durable response identity required before delivery');
 const record=readOwnRecord(store,response,'response',subjectId);
 const scene=qqScene(record.scene);
 ensure(scene,'DELIVERY_PIN_UNAVAILABLE','response has no concrete QQ delivery scene');
 return {allowedTargets:[scene],denyQQ:false,provenance:{kind:'response',id:record.id,revision:record.revision,scene}};
}
export function deliveryPinForAction({store,subjectId='jingyang',action,decision=null}){
 ensure(action?.id,'ACTION','durable action identity required before delivery');
 const record=readOwnRecord(store,action,'action',subjectId);
 // proactive_contact is an explicit persisted Action: its own targetScene is the pin,
 // but only when it is a private scene and the action carries persisted input material.
 // Group initiation is disabled in M1/M2; never derive a pin for it.
 if(record.tool==='proactive_contact'){
  const targetScene=record.args?.targetScene;
  if(/^qq\/group\//.test(String(targetScene??'')))throw deliveryReject('PROACTIVE_GROUP_DISABLED','proactive contact to qq/group is disabled; group peek is read-only');
  if(!/^qq\/private\/[0-9]+$/.test(String(targetScene??'')))throw deliveryReject('PROACTIVE_TARGET','proactive_contact requires an explicit persisted qq/private targetScene');
  if(!Array.isArray(record.inputRefs)||record.inputRefs.length===0||record.inputRefs.length>64||record.inputRefs.some(ref=>!ref||typeof ref.id!=='string'||!Number.isSafeInteger(ref.revision)||ref.revision<=0))
   throw deliveryReject('PROACTIVE_CONTEXT','proactive_contact requires persisted action.inputRefs material');
  return {allowedTargets:[targetScene],denyQQ:false,provenance:{kind:'proactive-contact',id:record.id,revision:record.revision,targetScene,inputRefs:record.inputRefs.map(ref=>({id:ref.id,revision:ref.revision}))}};
 }
 const allowed=new Set();
 // The encounter that triggered this action is the delivery authority. Used
 // materials may belong to other conversations and must not widen the pin.
 const source=record.inputRefs?.[0]?readOwnRecord(store,record.inputRefs[0],'event',subjectId):null;
 const sourceScene=qqScene(source?.scene);if(sourceScene)allowed.add(sourceScene);
 let parent=decision;
 if(!parent)parent=[...store.all('decision')].find(d=>d.action?.id===record.id&&(!d.input?.payload?.continuity?.subject?.id||d.input.payload.continuity.subject.id===subjectId))??null;
 if(parent)for(const scene of decisionInputTargets(parent.input))allowed.add(scene);
 if(!allowed.size)throw deliveryReject('DELIVERY_PIN_UNAVAILABLE','no persisted delivery source for this action');
 return {allowedTargets:[...allowed],denyQQ:false,provenance:{kind:'action',id:record.id,revision:record.revision,parentDecision:parent?{id:parent.id,revision:parent.revision}:null}};
}
export function deliveryPinForTask({store,subjectId='jingyang',task}){
 ensure(task&&typeof task==='object','DELIVERY_PIN','task required');
 const allowed=new Set();let source=null;
 if(task.originEventRef){
  const event=readOwnRecord(store,task.originEventRef,'event',subjectId);
  if(typeof store.subjectObservation==='function')ensure(store.subjectObservation(subjectId,event.id),'DELIVERY_PIN_UNAVAILABLE','task origin event was never admitted as an observation');
  const scene=qqScene(event.scene);if(scene){allowed.add(scene);source='origin-event';}
 }
 if(task.originDecisionRef){
  const origin=readOwnRecord(store,task.originDecisionRef,'decision',subjectId);
  for(const scene of decisionInputTargets(origin.input,{includeContactTargets:true}))allowed.add(scene);
  source=source??'origin-decision';
 }
 // Allow an explicitly scoped private QQ target when backed by an admitted observation for that scene.
 const explicitPrivate=typeof task.target==='string'&&/^qq\/private\/[0-9]+$/.test(task.target)?task.target:null;
 if(explicitPrivate&&!allowed.has(explicitPrivate)){
  const hasAdmitted=[...store.all('event')].some(e=>e.scene===explicitPrivate&&['observed','reported'].includes(e.origin)&&(typeof store.subjectObservation!=='function'||store.subjectObservation(subjectId,e.id)));
  if(hasAdmitted){allowed.add(explicitPrivate);source=source??'explicit-private-target';}
 }
 if(!allowed.size)return {allowedTargets:[],denyQQ:true,reason:'TASK_SCOPE_NARROW',provenance:{kind:'task',id:task.id??null,source:source??'none'}};
 return {allowedTargets:[...allowed],denyQQ:false,provenance:{kind:'task',id:task.id??null,source}};
}
export function assertPinnedDelivery({tool,args,pin}){
 if(!DELIVERY_SEND_TOOLS.includes(tool))return null;
 if(!pin||!Array.isArray(pin.allowedTargets)||pin.denyQQ===true)throw deliveryReject('DELIVERY_PIN_UNAVAILABLE',pin?.reason??'QQ delivery is not authorized for this origin');
 const scene=sendTargetScene(tool,args);
 if(!scene)throw deliveryReject('QQ_TARGET_ARGUMENTS','send target cannot be derived for the delivery pin');
 if(!pin.allowedTargets.includes(scene))throw deliveryReject('UNDELIVERED_TARGET','target is outside the committed delivery pin');
 return scene;
}
// Followup authorization: the target must be the scene of a delivered ORIGINAL event
// in its own basis. A store-wide contact list is not authority. Intended call sites:
// followup claim (server.followupTick, Lead) and send time (adapter.send below).
export function followupDeliveryAuthorization({store,subjectId='jingyang',followup}){
 ensure(followup&&typeof followup==='object','FOLLOWUP_TARGET','committed followup required');
 const target=qqScene(followup.targetScene);
 ensure(target,'FOLLOWUP_TARGET','followup target must be a concrete QQ scene');
 const basis=Array.isArray(followup.basis)?followup.basis:[];
 ensure(basis.length>0,'FOLLOWUP_TARGET','followup needs its original event basis');
 const supported=basis.some(ref=>{
  let event=null;try{event=store.read(ref?.id,ref?.revision);}catch{return false;}
  if(event?.type!=='event'||!['observed','reported'].includes(event.origin)||event.scene!==target)return false;
  if(typeof store.subjectObservation==='function'&&!store.subjectObservation(subjectId,event.id))return false;
  return true;
 });
 ensure(supported,'UNDELIVERED_TARGET','followup target must be the scene of a delivered original event in its own basis');
 return true;
}

// ---- Limbic runtime readiness: path + provenance before the worker probe ----
// A runtime that is missing/tampered must degrade the affect feature for this run,
// not refuse the whole brain. A packaged runtime is trusted only when the recorded
// provenance matches the actual files; an operator-provided interpreter is accepted
// as unverified (README documents JY_AFFECT_PYTHON for clean clones).
const AFFECT_RUNTIME_DIR='_local/affect-runtime';
const AFFECT_PYTHON_TAIL=['python-3.13.9','python.exe'];
export function affectRuntimeStatus({root=process.cwd(),env=process.env,asset=null,exists=existsSync,read=readFileSync}={}){
 const override=typeof env.JY_AFFECT_PYTHON==='string'&&env.JY_AFFECT_PYTHON.trim()?env.JY_AFFECT_PYTHON.trim():null;
 const source=asset?.source==='operator-provided'||override?'operator':'packaged';
 const pythonPath=asset?.path??override??join(root,AFFECT_RUNTIME_DIR,...AFFECT_PYTHON_TAIL);
 // An operator override may be a command name resolved through PATH ("python3");
 // a packaged runtime must be an existing file in the project.
 const commandName=source==='operator'&&!pythonPath.includes('/')&&!pythonPath.includes('\\');
 if(!exists(pythonPath)&&!commandName)return {ok:false,code:'AFFECT_RUNTIME_MISSING',source,pythonPath};
 if(source==='operator')return {ok:true,code:'AFFECT_RUNTIME_OPERATOR_PROVIDED',source:'operator',pythonPath,provenance:'unverified'};
 const provenancePath=asset?.provenancePath??join(root,AFFECT_RUNTIME_DIR,'PROVENANCE.json');
 if(!exists(provenancePath))return {ok:false,code:'AFFECT_PROVENANCE_MISSING',source:'packaged',pythonPath};
 let provenance;try{provenance=JSON.parse(read(provenancePath,'utf8'));}catch{return {ok:false,code:'AFFECT_PROVENANCE_INVALID',source:'packaged',pythonPath};}
 if(!provenance||typeof provenance!=='object'||typeof provenance.version!=='string'||provenance.signatureStatus!=='Valid'
   ||provenance.installedGlobally===true||provenance.pathChanged===true
   ||typeof provenance.exeSha256!=='string'||!/^[a-f0-9]{64}$/.test(provenance.exeSha256))
  return {ok:false,code:'AFFECT_PROVENANCE_INVALID',source:'packaged',pythonPath};
 const sha256=path=>{try{return createHash('sha256').update(read(path)).digest('hex');}catch{return null;}};
 if(sha256(pythonPath)!==provenance.exeSha256)return {ok:false,code:'AFFECT_PROVENANCE_MISMATCH',source:'packaged',pythonPath,part:'interpreter'};
 const archivePath=join(root,AFFECT_RUNTIME_DIR,`python-${provenance.version}-embed-amd64.zip`);
 let archive='absent';
 if(exists(archivePath)){
  if(typeof provenance.archiveSha256!=='string'||sha256(archivePath)!==provenance.archiveSha256)
   return {ok:false,code:'AFFECT_PROVENANCE_MISMATCH',source:'packaged',pythonPath,part:'archive'};
  archive='verified';
 }
 return {ok:true,code:'AFFECT_RUNTIME_VERIFIED',source:'packaged',pythonPath,provenance:{version:provenance.version,signatureStatus:provenance.signatureStatus,archive}};
}

// Configuration and authorization precede resource acquisition. No key is loaded here.
export async function launchBrain({root=process.cwd(),env=process.env,dependencies={}}={}){
 assertSupportedNode();
 const config=resolveBrainConfig({root,env});
 const scenePolicy=inboundScenePolicy({env});
 // requireToken is a startup precondition for both live and non-live launches; the
 // Lead-owned server route adds its own defense, bootstrap refuses first.
 if(scenePolicy.requireToken)
  ensure(typeof env.BRAIN_TOKEN==='string'&&env.BRAIN_TOKEN.length>=16,'BRAIN_TOKEN_REQUIRED','JY_REQUIRE_BRAIN_TOKEN=1 requires a local BRAIN_TOKEN of at least 16 characters');
 ensure(dependencies.core||existsSync(join(config.root,'src/store.mjs'))&&existsSync(join(config.root,'package.json')),'PROJECT_ROOT','launch from the actual project directory');
 // Live never silently starts from nothing or with unrestricted QQ reach: each needs an explicit acknowledgement.
 if(config.live){
  ensure(config.storePath===':memory:'||existsSync(config.storePath)||env.JY_NEW_SUBJECT==='1','NEW_SUBJECT_UNCONFIRMED','live store does not exist; set JY_NEW_SUBJECT=1 only if a brand-new subject is intended',{storePath:config.storePath});
  ensure(existsSync(config.ledgerPath)||env.JY_NEW_REQUEST_JOURNAL==='1','NEW_JOURNAL_UNCONFIRMED','request journal does not exist; set JY_NEW_REQUEST_JOURNAL=1 only for a first blank deployment',{ledgerPath:config.ledgerPath});
  ensure(!!env.QQ_TEST_ONLY_OWNER||env.JY_QQ_SCOPE==='all','QQ_SCOPE_UNCONFIRMED','set QQ_TEST_ONLY_OWNER, or JY_QQ_SCOPE=all to knowingly allow every friend and joined group');
  // Opt-in production prerequisite: deliveryPin is only trustworthy when the local
  // HTTP ingress is authenticated. Default stays off until deployment evidence and
  // existing test fixtures are updated; see the interface request to the Lead.
  if(env.JY_REQUIRE_BRAIN_TOKEN==='1')
   ensure(typeof env.BRAIN_TOKEN==='string'&&env.BRAIN_TOKEN.length>=16,'BRAIN_TOKEN_REQUIRED','JY_REQUIRE_BRAIN_TOKEN=1 requires a local BRAIN_TOKEN of at least 16 characters');
 }
 // The browser tab can go stale at any moment; the request journal already records
 // every paid request. Only enable this fallback explicitly, and still prefer the
 // official page whenever it is fresh.
 const journalSpend=config.live&&env.JY_JOURNAL_SPEND_FALLBACK==='1'?(now)=>{
  try{
   const data=JSON.parse(readFileSync(config.ledgerPath,'utf8'));
   const rows=Array.isArray(data.requests)?data.requests:[];
   const today=officialDay(now);let spendMicros=0,requestCount=0;
   for(const row of rows){
    if(officialDay(Number(row.recordedAt))!==today)continue;
    requestCount+=1;
    if(row.status==='settled'&&Number.isSafeInteger(row.actualMicros))spendMicros+=row.actualMicros;
    else if(Number.isSafeInteger(row.reserveMicros))spendMicros+=row.reserveMicros;
   }
   return {spendMicros,requestCount};
  }catch{return null;}
 }:null;
 const officialSpend=config.live?(dependencies.officialSpend??officialDashboard({file:join(config.stateDirectory,'official-usage.json'),token:env.JY_OFFICIAL_USAGE_TOKEN,spendFallback:journalSpend,keyLabel:env.THREADLINE_USAGE_KEY_LABEL})):null;
 const guard=claimBrainInstance({stateDirectory:config.stateDirectory});
 const shutdownToken=randomUUID();
 const SUBJECT_ID='jingyang';
 let model=null,requestJournal=null,service=null,maintenanceHeartbeat=null,stopping=null,drainRetry=null;
 async function stop(){
  if(stopping)return stopping;
  stopping=(async()=>{
   maintenanceHeartbeat?.stop();service?.beginShutdown?.();service?.stopScheduling?.();
   const deadline=Date.now()+(dependencies.shutdownWaitMs??3000);
   while(service?.health?.().cognitionBusy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
   ensure(!service?.health?.().cognitionBusy,'SHUTDOWN_BUSY','in-flight cognitive work remains; preserve ownership, retry after it finishes');
   if(service?.server?.listening)await new Promise((resolve,reject)=>service.server.close(error=>error?reject(error):resolve()));
   if(drainRetry){clearTimeout(drainRetry);drainRetry=null;}service?.close();model?.close();requestJournal?.close();guard.close();
   if(config.live)delete process.env.JY_REQUIRE_DELIVERY_PIN;
  })().catch(error=>{stopping=null;if(error.code==='SHUTDOWN_BUSY'&&!drainRetry){drainRetry=setTimeout(()=>{drainRetry=null;stop().then(()=>dependencies.onStopped?.()).catch(()=>{});},500);drainRetry.unref();}throw error;});
  return stopping;
 }
 try{
  const {identity,configFingerprint:effectiveFingerprint}=launchIdentity(config,{explicit:env.BRAIN_IDENTITY_FILE!==undefined});
  const build=runtimeSourceIdentity(config.root);
  const core=dependencies.core??await import('./server.mjs');
  let decide,sessionFactory=null,affectAdapter=null,affectDegraded=null,affectPlan=null,runtimeLoss=null;
  let affectRuntimeMeta={source:null,provenance:{status:'not-requested'}};
  let effectiveAffect={...config.affect},effectiveCognition=config.cognition;
  if(config.affect.enabled){
   affectAdapter=dependencies.affect??await import('../affect-integrated/session.mjs');
   const asset=typeof affectAdapter.resolveAffectRuntimeAsset==='function'?affectAdapter.resolveAffectRuntimeAsset({root:config.root,env}):null;
   const runtime=affectRuntimeStatus({root:config.root,env,asset});
   affectRuntimeMeta=runtime.ok
    ?{source:runtime.source,code:runtime.code,provenance:runtime.source==='operator'?{status:'unverified',origin:'operator-provided'}:{status:'verified',...(runtime.provenance??{})}}
    :{source:runtime.source,code:runtime.code,provenance:{status:'unavailable',code:runtime.code}};
   if(!runtime.ok){affectDegraded={requested:true,code:runtime.code,source:runtime.source};}
   else{
    // Environment/worker failures degrade the feature; configuration/profile errors
    // are still real bugs and keep the existing fail-closed behavior.
    const availability=typeof affectAdapter.probeAffectSafe==='function'
     ?await affectAdapter.probeAffectSafe(dependencies.affectOptions)
     :await (async()=>{try{await affectAdapter.probeAffect();return {available:true};}catch(error){
       const code=error?.code??'AFFECT_PROBE_FAILED';
       if(!['WORKER_UNAVAILABLE','WORKER_EXIT','WORKER_TIMEOUT','WORKER_PROTOCOL','WORKER_OUTPUT_LIMIT','WORKER_REJECTED','ENOENT'].includes(code))throw error;
       return {available:false,code,message:String(error?.message??'').slice(0,300)};
      }})();
    let plan;
    if(availability?.available===true){
     plan=typeof affectAdapter.planAffectRuntime==='function'
      ?affectAdapter.planAffectRuntime({affect:effectiveAffect,probe:availability,...dependencies.affectOptions})
      :{enabled:true,fusion:config.affect.fusion,sessionFactory:affectAdapter.affectFactory({fusion:config.affect.fusion,...dependencies.affectOptions}),degraded:false};
     // A plan that cannot wire a session is an internal code/contract bug, not an
     // environment degradation: fail closed instead of silently disabling affect.
     ensure(plan&&typeof plan==='object'&&typeof plan.enabled==='boolean','AFFECT_PLAN_INVALID','affect runtime plan is missing or malformed; refusing startup');
     ensure(!(plan.enabled===true&&plan.degraded===true),'AFFECT_PLAN_INVALID','affect plan cannot be enabled and degraded at once');
     if(plan.enabled){
      ensure(typeof plan.fusion==='boolean'&&typeof plan.sessionFactory==='function','AFFECT_PLAN_INVALID','enabled affect plan requires boolean fusion and a session factory; refusing startup');
     }else{
      ensure(plan.sessionFactory==null&&plan.degraded===true,'AFFECT_PLAN_INVALID','a disabled affect plan from an available probe must be explicitly degraded; refusing startup');
     }
    }else plan={enabled:false,fusion:false,sessionFactory:null,degraded:true,code:availability?.code??'AFFECT_UNAVAILABLE',reason:availability?.code??'AFFECT_UNAVAILABLE',message:availability?.message??null};
    affectPlan=plan;
    if(plan.enabled){
     const plannedFactory=plan.sessionFactory;
     // Runtime-loss after ready: the affect session reports its own degradation; keep
     // health honest for the rest of this process without touching the running service.
     sessionFactory=typeof plannedFactory==='function'
      ?args=>plannedFactory({...args,onDegraded:info=>{runtimeLoss=info??{reason:'AFFECT_RUNTIME_UNAVAILABLE'};}})
      :plannedFactory;
     effectiveAffect={enabled:true,fusion:plan.fusion===true};
    }
    else{affectDegraded={requested:true,code:plan.code??availability?.code??'AFFECT_UNAVAILABLE',source:runtime.source,message:plan.message??availability?.message??null};}
   }
   if(affectDegraded)effectiveAffect={enabled:false,fusion:false};
   // resolveBrainConfig forces apperception for fusion. If fusion was requested but
   // this run cannot honour it (degraded runtime or unsupported fusion), do not leave
   // that implicit channel enabled unless the operator asked explicitly.
   if(config.affect.fusion&&!effectiveAffect.fusion&&env.JY_APPERCEPTION_V1!=='1'&&(affectDegraded||affectPlan?.fusionFallback===true))
    effectiveCognition={...config.cognition,apperceptionV1:false};
  }
  if(config.live){
   const makeModel=dependencies.createModelDecision??(await import('../../src/model-transport.mjs')).createModelDecision;
   requestJournal=dependencies.requestJournal??new RequestJournal(config.ledgerPath);
   model=makeModel({ledgerPath:config.ledgerPath,blobDirectory:join(config.stateDirectory,'blobs'),profile:{...config.profile,formatRecovery:true},requestJournal,officialSpend});decide=model.decide;decide.requestJournal=requestJournal;
  }
  let registeredToolNames=[],agentTools={},effectiveHostTools=[],adapter={send:async()=>({delivered:false,mode:'dry-run'}),act:async()=>{ensure(false,'DRY_RUN_TOOL_DISABLED','dry-run cannot execute external tools');}};
  if(config.live){
   process.env.JY_REQUIRE_DELIVERY_PIN='1';
   const tools=dependencies.tools??await import('../qq-connect/tools.mjs');
   // Single configuration source for the Open-Life tool gate: use the resolved config
   // that built the grants. serve.mjs --open-life only set a local env copy, so the
   // tool host silently bypassed the policy layer (F-A-5). Fail-closed: a flag with no
   // host policy still throws LIFE_NOT_READY inside the tool host.
   if(config.openLife&&process.env.JY_OPEN_LIFE!=='1')process.env.JY_OPEN_LIFE='1';
   registeredToolNames=[...tools.TOOL_NAMES];
   decide.operationPolicy={registeredToolNames:tools.TOOL_NAMES,dependencyStatus:'not-confirmed',...(env.QQ_TEST_ONLY_OWNER?{externalSend:{target:'private',recipient:String(env.QQ_TEST_ONLY_OWNER),meaning:'仅此已授权私聊；通用Schema不授予群发送权限'}}:{})};
   // Explicit grants; advertised adapter names are not authority.
   const life=config.openLife?await import('../open-life/policy.mjs'):null;
   if(config.openLife)ensure(dependencies.lifePolicy,'LIFE_POLICY_REQUIRED','open life requires an explicit persistent host policy');
   const extraGrants=Array.isArray(dependencies.extraHostTools)?dependencies.extraHostTools:[];
   const baseGrants=config.openLife?life.OPEN_LIFE_TOOLS.filter(name=>!tools.UNAVAILABLE_TOOLS?.includes(name)):[...core.READ_ONLY_HOST_TOOLS,'qq_send_sticker'];
   const grants=[...new Set([...baseGrants,...extraGrants])];effectiveHostTools=grants;
   const responseTools=[...grants,'qq_send_message'];
   if(config.openLife)decide.operationPolicy.externalSend={scope:env.QQ_TEST_ONLY_OWNER?'only qq/private/'+env.QQ_TEST_ONLY_OWNER:'all actual friends and joined groups',requiresProactiveReason:true,perTargetCooldownMs:1800000,environment:dependencies.lifeEnvironment??{},idleReflectionIntervalMs:7200000,autonomousExplorationsPerDay:3,choice:'wait, none, continue or autonomous action; no action required'};
   if(config.openLife)decide.operationPolicy.life={environment:'open-life-v15',social:env.QQ_TEST_ONLY_OWNER?'only verified owner private chat':'all actual friends and joined groups; private information stays in its original context',idle:'at most one reflection per two hours and three autonomous explorations per Beijing day; wait/none allowed'};
   decide.operationPolicy.taskAllowedTools=grants.filter(name=>tools.TOOL_NAMES.includes(name));
   const hostStore=()=>{ensure(service?.store,'HOST_NOT_READY','external delivery requires the live service store');return service.store;};
   agentTools=Object.fromEntries(grants.filter(name=>tools.TOOL_NAMES.includes(name)).map(name=>[name,async (args,task)=>{
    const context={task,scene:task?.target,allowedTools:uniqueStrings(task?.metadata?.allowedTools),entry:'task'};
    if(DELIVERY_SEND_TOOLS.includes(name)){
     const pin=deliveryPinForTask({store:hostStore(),subjectId:SUBJECT_ID,task});
     assertPinnedDelivery({tool:name,args,pin});
     context.pinRequired=true;context.pinTargets=pin.allowedTargets;
    }
    return tools.executeTool(name,args,context);
   }]));
   adapter={
    act:async({tool,scene,action})=>{
     ensure(action?.id,'ACTION','durable action identity required before external delivery');
     const store=hostStore();
     const persisted=store.read(action.id,action.revision)??store.read(action.id);
     ensure(persisted?.type==='action','ACTION','persisted action required before external delivery');
     ensure(persisted.tool===tool,'ACTION_MISMATCH','outbox tool differs from the committed action');
     const context={scene,action,allowedTools:effectiveHostTools,entry:'decision'};
     if(DELIVERY_SEND_TOOLS.includes(persisted.tool)){
      const pin=deliveryPinForAction({store,subjectId:SUBJECT_ID,action:persisted});
      assertPinnedDelivery({tool:persisted.tool,args:persisted.args??{},pin});
      context.pinRequired=true;context.pinTargets=pin.allowedTargets;
     }
     return tools.executeTool(persisted.tool,persisted.args??{},context);
    },
    send:async({scene,text,response})=>{
     ensure(response?.id,'RESPONSE_REQUIRED','durable response identity required before sending');
     const split=splitQQTarget(scene);
     // Non-QQ concrete scenes (e.g. mc/*) stay non-QQ: preserve the previous
     // delivered:false contract; deliveryPin governs QQ delivery only.
     if(!split)return {delivered:false,scene};
     const store=hostStore();
     const pin=deliveryPinForResponse({store,subjectId:SUBJECT_ID,response});
     ensure(scene===pin.allowedTargets[0],'UNDELIVERED_TARGET','caller scene differs from the committed response scene');
     const record=store.read(response.id,response.revision)??store.read(response.id);
     const decision=record?.decision?store.read(record.decision.id,record.decision.revision):null;
     // A pruned decision input must not turn followup authorization into fail-open.
     // Fall back to the persisted attention frame entry for the committed target.
     const frame=store.read(attentionId(SUBJECT_ID));
     const persistedFollowup=(frame?.followups??[]).find(f=>f.targetScene===pin.allowedTargets[0]&&['claimed','scheduled','sent','unknown'].includes(f.status))??null;
     const followup=decision?.input?.payload?.followup??persistedFollowup;
     if(followup){
      ensure(followup.targetScene===pin.allowedTargets[0],'UNDELIVERED_TARGET','followup target differs from the committed response scene');
      followupDeliveryAuthorization({store,subjectId:SUBJECT_ID,followup});
     }
     return tools.executeTool('qq_send_message',{target:split.target,id:split.id,text},{scene,response,entry:'response',allowedTools:responseTools,pinRequired:true,pinTargets:pin.allowedTargets});
    }
   };
  }
  if(sessionFactory)sessionFactory=withTypedStateContract(sessionFactory);
  const runtimeInfo={openLife:config.openLife,mode:config.mode,configFingerprint:effectiveFingerprint,buildFingerprint:build.fingerprint,ledgerPath:config.ledgerPath,cognition:effectiveCognition,affect:{...effectiveAffect,requested:config.affect.enabled,source:affectRuntimeMeta.source,provenance:affectRuntimeMeta.provenance,...(affectRuntimeMeta.code?{runtimeCode:affectRuntimeMeta.code}: {}),...(affectDegraded?{degraded:true,reason:affectDegraded.code,source:affectDegraded.source??affectRuntimeMeta.source??null}: {})}};
  const nativeActions=['remember_note','channel_control','group_peek','start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task','proactive_contact'];
  const allowedNative=dependencies.nativeActions===undefined?nativeActions:nativeActions.filter(name=>dependencies.nativeActions.includes(name));
  const allowed=config.live?[...effectiveHostTools,...allowedNative].filter(name=>allowedNative.includes(name)||registeredToolNames.includes(name)):[];
  const memoryModels=config.semanticMemory;
  const semanticMemory=dependencies.semanticMemory??(memoryModels?new SemanticMemory({encode:localE5Encoder(memoryModels),
   rerank:memoryModels.rerankerDirectory?localMemoryReranker(memoryModels):null}):null);
  service=await core.startBrainService({port:config.port,token:env.BRAIN_TOKEN??null,inboundScenePolicy:scenePolicy,storePath:config.storePath,stateDirectory:config.stateDirectory,styleDirectory:config.styleDirectory,
   heartbeatMs:0,decide,identity,rhythm:config.rhythm,cognition:effectiveCognition,runtimeInfo,autonomy:config.autonomy,shutdownControl:{token:shutdownToken,stop:async()=>{await stop();dependencies.onStopped?.();}},global:config.global,subjectTask:true,idleIntervalMs:config.idleIntervalMs,rhythmReset:config.rhythmReset,intentProtocol:config.profile.intentProtocol,timezoneMinutes:config.timezoneMinutes,semanticMemory,
   sessionFactory,theoryStatus:()=>{
  if(runtimeLoss)return {enabled:false,available:false,version:null,degraded:true,code:runtimeLoss.reason??'AFFECT_RUNTIME_UNAVAILABLE',runtimeDegraded:true};
  if(affectAdapter&&affectPlan&&typeof affectAdapter.affectTheoryStatus==='function')return affectAdapter.affectTheoryStatus(affectPlan);
  return effectiveAffect.enabled?{enabled:true,available:true,version:'limbic-v1',fusion:effectiveAffect.fusion}:{enabled:false,available:false,version:null,...(affectDegraded?{degraded:true,code:affectDegraded.code,reason:affectDegraded.code}: {})};
 },
   capabilities:['remember','open','relate','say','do','wait',...allowed],
   officialSpend,agentTools,hostAllowedTools:effectiveHostTools,lifePolicy:config.openLife?dependencies.lifePolicy:null,allowedActionTools:allowed,adapter,
   storage:{maxDebugPacketBytes:Number(env.JY_DEBUG_PACKET_BYTES??8*1024*1024),maxDebugEvents:Number(env.JY_DEBUG_EVENTS??512),hotDecisionPackets:Number(env.JY_MODEL_PACKET_HOT??64),terminalAffectPackets:Number(env.JY_TERMINAL_AFFECT_PACKETS??64),maxModelPacketBytes:Number(env.JY_MODEL_PACKET_MAX_BYTES??8*1024*1024)}});
  if(affectDegraded){
  try{service.store.recordDiagnostic({stage:'affect.degraded',status:'degraded',context:{subjectId:'jingyang'},data:{requested:true,reason:affectDegraded.code,source:affectDegraded.source??null,message:affectDegraded.message??null,requestedFusion:config.affect.fusion,fusion:effectiveAffect.fusion}});}catch{}
  try{console.error('[affect] degraded:',affectDegraded.code);}catch{}
 }
 if(affectAdapter&&effectiveAffect.enabled)affectAdapter.verifyStoredAffect({store:service.store,subjectId:'jingyang',config:dependencies.affectOptions?.config});
  ensure(runtimeSourceIdentity(config.root).fingerprint===build.fingerprint,'SOURCE_CHANGED_DURING_BOOT','startup inventory changed; no ready instance published');
  const instance=guard.publish({format:'jingyang-brain-instance-v1',status:'ready',mode:config.mode,affect:effectiveAffect.enabled,fusion:effectiveAffect.fusion,
   startedAt:new Date().toISOString(),shutdownToken,storePath:config.storePath,ledgerPath:config.ledgerPath,stateDirectory:config.stateDirectory,global:config.global,
   configFingerprint:effectiveFingerprint,build,cognition:effectiveCognition,port:service.port,url:service.url});
  if(config.maintenance){
   const maintenance=dependencies.maintenance??await import('../../src/maintenance.mjs');
   const session=new maintenance.MaintenanceSession({store:service.store,subjectId:'jingyang',identity});
   maintenanceHeartbeat=maintenance.startMaintenanceHeartbeat({session,isBusy:()=>{const h=service.health();return h.cognitionBusy===true||h.active!==null||(h.pending?.length??0)>0;},
    runExclusive:fn=>service.runCognitionExclusive(fn),invoke:model.invokeMaintenance,authorize:async()=>officialSpend.gate().allow,
    onResult:r=>console.error('[maintenance]',r.status??'unknown'),onError:e=>console.error('[maintenance]',e.code??'MAINTENANCE_ERROR')});
  }
  service.startScheduling(config.heartbeatMs);
  return {service,instance,config,stop,summary:{url:service.url,port:service.port,mode:config.mode,affect:effectiveAffect.enabled,fusion:effectiveAffect.fusion,
   affectRequested:config.affect.enabled,...(affectDegraded?{affectDegraded:{code:affectDegraded.code,source:affectDegraded.source??null}}: {}),
   storePath:config.storePath,stateDirectory:config.stateDirectory,heartbeatMs:config.heartbeatMs,identityFile:config.identityFile,identityChars:identity.length,
   maintenance:!!maintenanceHeartbeat,configFingerprint:effectiveFingerprint,buildFingerprint:build.fingerprint}};
 }catch(error){
  try{await stop();}catch(cleanupError){error.cleanupError=cleanupError.code??'BOOT_CLEANUP_FAILED';}
  throw error;
 }
}
