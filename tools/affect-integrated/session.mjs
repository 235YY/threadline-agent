import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ContinuitySession,compileIntentOutput} from '../../src/continuity-session.mjs';
import {prepareReflection} from '../../src/cognition.mjs';
import {canonical,digest,ensure,text} from '../../src/contracts.mjs';
import {motivationId,affectTurnId,validateSnapshot,normalizeAffectAppraisal,sourceFor,hasApplied,motivationInput,verifyTransition} from '../../src/affect-contract.mjs';
import * as attentionApi from '../../src/attention.mjs';
// Capacity classification is owned by attention.mjs; keep a local fallback only while
// the B-owned interface is landing so this module remains loadable. The same code list
// is host resource exhaustion, never a model-semantic rejection.
const isAttentionCapacityError=code=>typeof attentionApi.isAttentionCapacityError==='function'
 ? attentionApi.isAttentionCapacityError(code)
 : ['FOREGROUND_CAPACITY','ATTENTION_CAPACITY'].includes(code);
import {callWorker} from '../affect-shadow/bridge.mjs';
import {fusionContext,completeEmotionProjection,normalizeFusionAppraisal,meaningWrite} from './fusion.mjs';
const FUSION_PROMPT=readFileSync(new URL('../../prompts/decision-affect-fusion.zh.md',import.meta.url),'utf8');
const AFFECT_PROMPT=readFileSync(new URL('../../prompts/decision-affect.zh.md',import.meta.url),'utf8');
const ref=x=>({id:x.id,revision:x.revision});
const copy=x=>JSON.parse(canonical(x));
const requestSource=(subject,p)=>p.task?{subject,kind:'task',taskId:p.task.id,step:p.task.stepCount}:(p.currentEvent??p.current)?{subject,kind:'event',event:ref(p.currentEvent??p.current)}:p.requestSource??null;

function verifyProfile(snapshot,config){
 validateSnapshot(snapshot);ensure(snapshot.config.timezoneMinutes===(config.timezoneMinutes??480)&&canonical(snapshot.config.parameters)===canonical(config.parameters??{}),'AFFECT_PROFILE','explicit new phase required to change profile');
}
export function verifyStoredAffect({store,subjectId='jingyang',config={timezoneMinutes:480,parameters:{}}}){
 const subject=store.read(subjectId);if(!subject?.motivationState)return;
 const record=store.read(subject.motivationState.id,subject.motivationState.revision);
 ensure(record?.type==='motivation_state'&&record.subject===subjectId,'AFFECT_REFERENCE','own persisted affect state required');verifyProfile(record.snapshot,config);
}
export async function probeAffect({worker=callWorker,config={timezoneMinutes:480,parameters:{}}}={}){
 const result=await worker({action:'initialize',nowMs:Date.now(),config});verifyProfile(result.state,config);
 return {available:true,upstream:result.state.upstream,profileHash:digest(result.state.config)};
}

// Phase 3.2 degradation contract. A probe/runtime environment failure is not a
// reason to refuse the whole core service; it is classified and reported. Profile
// or contract errors (AFFECT_PROFILE/AFFECT_STATE/...) are NOT swallowed here:
// the caller decides whether that is a configuration error (fail-closed) or a
// degradation trigger.
const ENV_FAILURE_CODES=new Set(['WORKER_UNAVAILABLE','WORKER_TIMEOUT','WORKER_EXIT','WORKER_PROTOCOL','WORKER_REJECTED','WORKER_OUTPUT_LIMIT','ENOENT']);
// Only deterministic appraisal/state validation failures may fall back to core-only
// adoption. Identity/binding mismatches (AFFECT_CAPTURE_OUTPUT_MISMATCH,
// AFFECT_PACKET_CHANGED, AFFECT_OUTPUT_CHANGED, AFFECT_COMMIT_MISMATCH, AFFECT_TURN,
// AFFECT_WORKER_BINDING, AFFECT_PROFILE*, AFFECT_STATE*, OUTPUT_JSON, core
// ContractErrors) must stay fail-closed and are deliberately absent here.
const AFFECT_SIDE_FALLBACK_CODES=new Set(['STALE_MOTIVATION','AFFECT_DISABLED','AFFECT_ALREADY_APPRAISED','AFFECT_APPRAISAL_SHAPE','AFFECT_APPRAISAL_LIMIT','AFFECT_APPRAISAL_FIELD','AFFECT_APPRAISAL_RANGE','AFFECT_SOURCE','AFFECT_TARGET','AFFECT_WEIGHT','AFFECT_FUSION_SCHEMA','AFFECT_MODE','AFFECT_REASON','AFFECT_INTERPRETATION','AFFECT_CONCERN','AFFECT_PREVIOUS','AFFECT_NO_CHANGE']);
export const AFFECT_PYTHON_REL='_local/affect-runtime/python-3.13.9/python.exe';
// Resolve where the worker interpreter comes from without spawning it. A packaged
// interpreter is the default; JY_AFFECT_PYTHON is an explicit operator-provided
// override (its provenance is not verified here).
export function resolveAffectRuntimeAsset({root=fileURLToPath(new URL('../../',import.meta.url)),env=process.env}={}){
 ensure(typeof root==='string'&&root.length>0,'AFFECT_RUNTIME_ASSET','project root required');
 const packaged=join(root,'_local','affect-runtime','python-3.13.9','python.exe');
 const requested=typeof env.JY_AFFECT_PYTHON==='string'&&env.JY_AFFECT_PYTHON.trim()?env.JY_AFFECT_PYTHON.trim():null;
 const path=requested??packaged;
 return {path,source:requested?'operator-provided':'packaged',exists:existsSync(path),packaged,
   provenancePath:join(root,'_local','affect-runtime','PROVENANCE.json'),provenanceExists:existsSync(join(root,'_local','affect-runtime','PROVENANCE.json'))};
}
// Never rejects for a worker/environment failure. Only a decoded availability result
// is returned so bootstrap can degrade instead of refusing to start.
export async function probeAffectSafe({worker=callWorker,config={timezoneMinutes:480,parameters:{}}}={}){
 try{
  const result=await probeAffect({worker,config});
  return {available:true,degraded:false,upstream:result.upstream,profileHash:result.profileHash,fusionSupported:true};
 }catch(error){
  const code=typeof error?.code==='string'?error.code:'AFFECT_PROBE_FAILED';
  if(!ENV_FAILURE_CODES.has(code))throw error;
  return {available:false,degraded:true,code,message:String(error?.message??'affect probe failed').slice(0,240),fusionSupported:false};
 }
}
// Pure plan: requested affect flags + probe result -> effective runtime wiring.
// Degraded: no AffectSession, no motivation/affect_turn writes, fusion falls back off.
export function planAffectRuntime({affect={enabled:false,fusion:false},probe=null,onDegraded=null,config,worker}={}){
 ensure(affect&&typeof affect.enabled==='boolean'&&typeof affect.fusion==='boolean','AFFECT_PLAN','explicit affect booleans required');
 ensure(onDegraded===null||typeof onDegraded==='function','AFFECT_PLAN','onDegraded must be null or a function');
 if(!affect.enabled)return {requested:{enabled:false,fusion:false},enabled:false,fusion:false,degraded:false,sessionFactory:null,reason:'disabled',probe:null};
 if(!probe||probe.available!==true){
  const code=probe?.code??'AFFECT_PROBE_UNAVAILABLE';
  return {requested:{enabled:true,fusion:affect.fusion},enabled:false,fusion:false,degraded:true,sessionFactory:null,code,reason:code,
    message:probe?.message??null,probe:probe??null};
 }
 const fusionSupported=probe.fusionSupported!==false;
 const fusion=affect.fusion===true&&fusionSupported;
 const plan={requested:{enabled:true,fusion:affect.fusion},enabled:true,fusion,degraded:false,sessionFactory:affectFactory({fusion,onDegraded,...(config?{config}:{}),...(worker?{worker}:{})}),probe,
   ...(affect.fusion&&!fusion?{fusionFallback:true,fusionReason:'FUSION_UNSUPPORTED'}:{})};
 return plan;
}
// Operator-facing health projection; keeps requested/effective distinct.
export function affectTheoryStatus(plan){
 if(!plan)return {enabled:false,available:false,version:null};
 if(plan.enabled)return {enabled:true,available:true,version:'limbic-v1',fusion:plan.fusion===true,...(plan.fusionFallback?{fusionFallback:true,fusionReason:plan.fusionReason}:{})};
 return {enabled:false,available:false,version:null,degraded:plan.degraded===true,requested:plan.requested??null,...(plan.code?{code:plan.code}:{}),...(plan.reason?{reason:plan.reason}:{})};
}
// Convenience for bootstrap: one call returns probe evidence + the plan.
export async function prepareAffectRuntime({affect={enabled:false,fusion:false},worker=callWorker,config={timezoneMinutes:480,parameters:{}},asset=null,onDegraded=null}={}){
 const resolvedAsset=asset??resolveAffectRuntimeAsset();
 if(!resolvedAsset.exists){
  const probe={available:false,degraded:true,code:'AFFECT_RUNTIME_MISSING',fusionSupported:false,message:'packaged affect python runtime not found'};
  return {asset:resolvedAsset,probe,plan:planAffectRuntime({affect,probe,onDegraded})};
 }
 const probe=await probeAffectSafe({worker,config});
 return {asset:resolvedAsset,probe,plan:planAffectRuntime({affect,probe,onDegraded})};
}

// Complete opt-in session. The worker never receives the store/database path.
export class AffectSession {
 constructor({store,subjectId,attention=true,maxForeground=16,worker=callWorker,config={timezoneMinutes:480,parameters:{}},clock=()=>store.clockNow(),fusion=false,requestJournal=null,onDegraded=null}={}){
  ensure(typeof fusion==='boolean','AFFECT_CONFIG','explicit fusion boolean');
  ensure(onDegraded===null||typeof onDegraded==='function','AFFECT_CONFIG','onDegraded must be null or a function');
  Object.assign(this,{store,subjectId,worker,config,clock,fusion,requestJournal});this.core=new ContinuitySession({store,subjectId,attention,maxForeground,requestJournal});
  // Runtime-loss fallback: once the affect worker is unavailable after startup, this
  // session stops using affect entirely for the rest of its life (no retry loop that
  // could stall turns). No affect state is adopted; core ContinuitySession continues.
  this.onDegraded=onDegraded;this.degraded=false;this.degradedReason=null;this.degradedPhase=null;this.degradedMessage=null;this.degradedAt=null;
  if(requestJournal)for(const t of store.all('affect_turn')){
   if(t.subject!==subjectId||t.status!=='dispatched')continue;
   const request=requestJournal.packetRequest(t.packet.packetId)??requestJournal.tryFind('turn:'+t.packet.packetId);
   // The bound Journal alone proves a genuinely active model request. Missing
   // or already-ended request facts never prove that this orphan turn succeeded.
   if(request?.status!=='dispatched')
    store.execute({requestId:'affect-interrupted:'+t.id+':'+t.revision,commands:[{op:'affect_turn',id:t.id,expectedRevision:t.revision,status:'uncertain',error:'INTERRUPTED_DISPATCH',failurePhase:'journal-recovery',transportInvoked:null}]});
  }
 }
 status(){return {degraded:this.degraded,reason:this.degradedReason,phase:this.degradedPhase,message:this.degradedMessage,at:this.degradedAt};}
 #degrade(error,phase){
  if(this.degraded)return;
  this.degraded=true;this.degradedReason=typeof error?.code==='string'?error.code:'AFFECT_RUNTIME_UNAVAILABLE';
  this.degradedPhase=phase??null;this.degradedMessage=String(error?.message??'').slice(0,240);this.degradedAt=this.clock();
  try{this.store.recordDiagnostic({stage:'affect.runtime-degraded',status:'degraded',context:{subjectId:this.subjectId},
    data:{code:this.degradedReason,phase:this.degradedPhase,message:this.degradedMessage,
      meaning:'affect worker unavailable after startup; this session continues without affect and adopts no affect state'}});}catch{}
  const info=this.status();
  try{this.onDegraded?.(info);}catch{}
 }
 async #workerCall(input,phase){
  try{return await this.worker(input);}
  catch(error){
   const code=error?.code;
   if(typeof code==='string'&&ENV_FAILURE_CODES.has(code))this.#degrade(error,phase);
   throw error;
  }
 }
 #markAffectTurnFailed(packet,phase='runtime-degraded',errorCode=this.degradedReason??'AFFECT_RUNTIME_UNAVAILABLE'){
  if(!packet)return;
  const turn=this.store.read(affectTurnId(packet));if(!turn)return;
  if(!['prepared','captured'].includes(turn.status))return;
  try{this.store.execute({requestId:'affect-degraded:'+turn.id+':'+turn.revision,commands:[{op:'affect_turn',id:turn.id,
    expectedRevision:turn.revision,status:'failed',error:errorCode,failurePhase:phase}]});}catch{}
 }
 #stripAffectOutput(output){
  if(output===null||output===undefined)return output;
  let parsed;try{parsed=typeof output==='string'?JSON.parse(output):copy(output);}catch{return output;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Object.hasOwn(parsed,'affectAppraisal'))return output;
  delete parsed.affectAppraisal;
  return JSON.stringify(parsed);
 }
 #fallbackCommit(args){
  this.#markAffectTurnFailed(args.packet);
  const output=this.#stripAffectOutput(args.output);
  return this.core.commit({...args,output,motivationTransition:null,affectTurn:null,extensionWrites:args.extensionWrites??[]});
 }
 async initialize(nowMs=this.clock()){
  if(this.degraded)return null;
  const old=this.store.read(motivationId(this.subjectId));
  if(old){verifyProfile(old.snapshot,this.config);return old;}
  const initialized=await this.#workerCall({action:'initialize',nowMs,config:this.config},'initialize');validateSnapshot(initialized.state);
  return this.store.execute({requestId:'affect-init:'+this.subjectId+':'+digest(this.config),commands:[{op:'initialize_motivation',subjectId:this.subjectId,snapshot:initialized.state}]}).at(-1);
 }
 async #prepare(args,reflection){
  ensure(!args.subjectId||args.subjectId===this.subjectId,'SUBJECT_FIXED','fixed subject');
  const now=args.now??this.clock();await this.initialize(now);
  const keyArgs=copy(Object.fromEntries(Object.entries(args).filter(([k])=>!['store','subjectId','now'].includes(k))));
  const argsKey=digest({reflection,args:keyArgs,...(this.fusion?{fusion:true}:{})});
  const turns=[...this.store.all('affect_turn')].filter(t=>t.subject===this.subjectId);
  const source=requestSource(this.subjectId,args),request=source?this.requestJournal?.sourceRequest(source):null;
  const admitted=request&&(request.status==='reserved'&&request.fingerprint===null||request.status==='settled'&&(request.validation?.status==='accepted'||Boolean(request.retryAuthorization)));
  const same=t=>source&&canonical(t.requestSource??requestSource(this.subjectId,t.packet.payload))===canonical(source);
  ensure(admitted||!turns.some(t=>t.status==='closed-incomplete'&&same(t)),'AFFECT_SOURCE_STOPPED','closed source requires explicit request readmission');
  ensure(admitted||!turns.some(t=>['failed','uncertain'].includes(t.status)&&same(t)),'AFFECT_TURN_STOPPED','same failed source cannot revive by changing time');
  const pending=turns.filter(t=>!['committed','closed-incomplete','superseded'].includes(t.status));
  ensure(!pending.some(t=>t.status==='dispatched'),'AFFECT_TURN_STOPPED','an in-flight model turn still owns the affect slot; do not overlap it');
  const captured=pending.find(t=>t.status==='captured');
  if(captured){ensure(captured.argsKey===argsKey,'AFFECT_CAPTURE_PENDING','finish the captured turn before another task');return captured.packet;}
  const prepared=pending.find(t=>t.status==='prepared'&&t.argsKey===argsKey);
  if(prepared)return prepared.packet;
  ensure(!request||admitted,'AFFECT_SOURCE_STOPPED','request journal has not admitted this source');
  const old=this.store.read(motivationId(this.subjectId));
  const operation={id:'preview:'+digest({ref:ref(old),now}),kind:'advance',expectedRevision:old.snapshot.revision,nowMs:now};
  const advanced=await this.#workerCall({action:'transition',state:old.snapshot,operation},'preview');
  validateSnapshot(advanced.state);ensure(advanced.state.wallAt===now&&advanced.state.revision===old.snapshot.revision+1&&advanced.receipt?.operationId===operation.id,'AFFECT_WORKER_BINDING','wrong preview time/version/operation');
  const preview={baseRef:ref(old),baseHash:digest(old.snapshot),snapshot:advanced.state};
  const {hostActivity,...coreArgs}=args;
  if(hostActivity){const event=this.store.read(args.currentEvent?.id,args.currentEvent?.revision);ensure(!reflection&&event?.origin==='tool_receipt'&&[...this.store.all('action')].some(a=>a.receipt?.id===event.id),'AFFECT_ACTIVITY_SOURCE','activity cost requires actual recorded action receipt');}
  let motivation=motivationInput({store:this.store,subjectId:this.subjectId,currentEvent:args.currentEvent,preview});
  let internalSources=[];
  if(this.fusion){motivation.projection=completeEmotionProjection(advanced.state);const context=fusionContext({store:this.store,subjectId:this.subjectId,motivation,currentEvent:args.currentEvent,materials:args.materials,stateRefs:args.stateRefs});motivation=context.motivation;internalSources=context.internalSources;}
  const preparedArgs={...coreArgs,motivationProjection:motivation,...(this.fusion?{internalSources,apperceptionV1:true}:{}),instructionSuffix:[args.instructionSuffix,this.fusion?FUSION_PROMPT:AFFECT_PROMPT].filter(Boolean).join('\n\n')};
  const packet=reflection?prepareReflection({...preparedArgs,store:this.store,subjectId:this.subjectId}):this.core.prepare(preparedArgs);
  const value={subject:this.subjectId,status:'prepared',argsKey,packet,preview,hostActivity:hostActivity??null,rawOutput:null,...(source?{requestSource:source}:{})};
  this.store.execute({requestId:'affect-prepare:'+packet.packetId,commands:[{op:'affect_turn',id:affectTurnId(packet),expectedRevision:0,value}]});return packet;
 }
 prepare(args){
  if(this.degraded)return this.core.prepare(args);
  return this.#prepare(args,false).catch(error=>{if(this.degraded)return this.core.prepare(args);throw error;});
 }
 prepareReflection(args){
  if(this.degraded)return this.core.prepareReflection(args);
  return this.#prepare(args,true).catch(error=>{if(this.degraded)return this.core.prepareReflection(args);throw error;});
 }
 // Autonomy may see the last stored snapshot. There is no encounter appraisal or
 // worker transition to invoke or adopt when the subject chooses what to do here.
 prepareAutonomy(args){
  const motivationProjection=this.degraded?null:motivationInput({store:this.store,subjectId:this.subjectId});
  return this.core.prepareAutonomy({...args,motivationProjection});
 }
 async supersede(packet,error){
  if(this.degraded)return;
  const turn=this.store.read(affectTurnId(packet));if(turn?.status!=='captured')return;
  this.store.execute({requestId:'supersede:'+turn.id,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'superseded',error:error.code??'HOST_CONTROL_CHANGED'}]});
 }
 capturedOutput(packet){if(this.degraded)return null;const t=this.store.read(affectTurnId(packet));return t?.status==='captured'&&canonical(t.packet)===canonical(packet)?t.rawOutput:null;}
 async invoke(packet,fn){
  if(packet.payload.internal?.kind==='autonomy')return this.core.invoke(packet,fn);
  if(this.degraded)return fn(packet);
  let turn=this.store.read(affectTurnId(packet));ensure(turn&&turn.subject===this.subjectId,'AFFECT_TURN','prepared input required');
  ensure(canonical(packet)===canonical(turn.packet),'AFFECT_PACKET_CHANGED','use the exact stored input');
  if(turn.status==='captured')return turn.rawOutput;
  ensure(turn.status==='prepared','AFFECT_TURN_STOPPED','never automatically resend a dispatched turn');
  const others=[...this.store.all('affect_turn')].filter(t=>t.subject===this.subjectId&&t.id!==turn.id);
  ensure(!others.some(t=>['dispatched','captured'].includes(t.status)),'AFFECT_TURN_STOPPED','another actual invocation/capture owns the subject slot');
  const source=turn.requestSource??requestSource(this.subjectId,packet.payload),request=source?this.requestJournal?.sourceRequest(source):null;
  const admitted=request&&(request.status==='reserved'&&request.fingerprint===null||request.status==='settled'&&(request.validation?.status==='accepted'||Boolean(request.retryAuthorization)));
  ensure(admitted||!others.some(t=>['failed','uncertain','closed-incomplete'].includes(t.status)&&source&&canonical(t.requestSource??requestSource(this.subjectId,t.packet.payload))===canonical(source)),'AFFECT_TURN_STOPPED','original source is still stopped');
  ensure(!request||admitted,'AFFECT_SOURCE_STOPPED','request identity is already claimed');
  ensure(this.store.read(this.subjectId)?.revision===packet.payload.continuity.subject.revision,'STALE_SUBJECT','subject changed before invocation');
  const base=this.store.read(motivationId(this.subjectId));
  ensure(base&&canonical(ref(base))===canonical(turn.preview.baseRef)&&digest(base.snapshot)===turn.preview.baseHash,'STALE_MOTIVATION','motivation changed before invocation');
  ensure(this.store.read(packet.payload.workspace.id)?.revision===packet.payload.workspace.revision,'STALE_WORKSPACE','workspace changed before invocation');
  turn=this.store.execute({requestId:'affect-dispatch:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'}]}).at(-1);
  let raw;
  try{raw=await fn(packet);raw=typeof raw==='string'?raw:canonical(raw);ensure(Buffer.byteLength(raw)<=32768,'AFFECT_OUTPUT_LIMIT','bounded public output');}
  catch(error){
   const unsent=error.transportInvoked===false,status=unsent?'failed':'uncertain';
   try{this.store.execute({requestId:'affect-'+status+':'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status,error:error.code??'MODEL_ERROR',failurePhase:unsent?'before-transport':'invocation',transportInvoked:error.transportInvoked??null}]});}
   catch(recording){error.affectFailureRecording='failed';error.affectFailureError=recording.code??'PERSISTENCE_ERROR';}
   throw error;
  }
  this.store.execute({requestId:'affect-capture:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'captured',rawOutput:raw}]});return raw;
 }
 // IR-05: adopt a durable captured decision_attempt without invoking a model.
 // The named arguments and journal rules match ContinuitySession.commitCaptured;
 // the final transaction always goes through core.commitCaptured so a task-source
 // adoption is never recorded as a model-semantic rejection.
 async commitCaptured(args){
  const packet=args?.packet;
  ensure(['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph'].includes(packet?.stage)&&packet.payload.continuity.subject.id===this.subjectId,'SUBJECT_FIXED','input belongs to another subject/session');
  text(args?.decisionId,'decision id');text(args?.requestId,'request id');
  const existing=this.store.read(args.decisionId);
  if(existing){
   ensure(existing.type==='decision'&&existing.input?.packetId===packet.packetId&&existing.requestKey===args.requestId,'DECISION_ID_COLLISION','captured decision id belongs to another request');
   return existing;
  }
  const row=this.requestJournal?.packetRequest(packet.packetId);
  ensure(row&&row.status==='settled'&&row.validation?.status!=='rejected'&&row.validation?.status!=='accepted','TASK_CAPTURE_STATE','settled, unadopted captured request required');
  const output=typeof args.output==='string'?args.output:canonical(args.output);
  const turn=this.store.read(affectTurnId(packet));
  // A prepared/dispatched/uncertain affect turn has no adoptable captured state.
  // Refuse with a typed code so the task-source surface keeps the task for
  // operator review instead of inventing a decision or affect state.
  if(turn&&['prepared','dispatched','uncertain'].includes(turn.status))
   throw Object.assign(new Error(`affect turn is ${turn.status}; captured adoption requires a captured turn`),{code:'AFFECT_CAPTURE_UNAVAILABLE',details:{turnStatus:turn.status,turnId:turn.id}});
  if(this.degraded){
   if(turn)this.#markAffectTurnFailed(packet,'runtime-degraded');
   return this.#coreCapturedCommit(args,output,'runtime-degraded');
  }
  if(!turn||['failed','superseded','closed-incomplete'].includes(turn.status))
   return this.#coreCapturedCommit(args,output,turn?.status??'missing');
  // captured (or committed with a still-missing decision): reuse the affect commit
  // validation but make the final adoption a captured commit, so no normalizeAndRecord
  // and no journal rejection is produced.
  try{return await this.#commitAffect(args,{captured:true});}
  catch(error){
   const code=typeof error?.code==='string'?error.code:'';
   // G P2: identity/output mismatch is not an affect degradation. It means the
   // captured affect turn and the captured decision_attempt are not the same
   // proposal, so neither side may be adopted. Fail closed, with no journal
   // accepted/rejected and no core-only adoption.
   if(code==='AFFECT_CAPTURE_OUTPUT_MISMATCH'){
    try{this.store.recordDiagnostic({stage:'affect.capture-identity-mismatch',status:'rejected',context:{subjectId:this.subjectId,packetId:packet.packetId},
      data:{errorCode:code,meaning:'captured affect output does not match the captured core decision; refusal to adopt either side'}});}catch{}
    this.#markAffectTurnFailed(packet,'capture-identity-mismatch',code);
    throw error;
   }
   if(this.degraded){this.#markAffectTurnFailed(packet,'runtime-degraded');return this.#coreCapturedCommit(args,output,'worker-unavailable');}
   // IL-max IR-05 rule: an affect-side deterministic validation failure must not
   // block task-source adoption. The captured core decision is still adopted with
   // no affect state; only an invalid core decision payload stays fail-closed.
   if(AFFECT_SIDE_FALLBACK_CODES.has(code)){
    try{this.store.recordDiagnostic({stage:'affect.capture-affect-fallback',status:'degraded',context:{subjectId:this.subjectId,packetId:packet.packetId},
      data:{errorCode:code,meaning:'affect-side captured validation failed; core decision adopted without affect state'}});}catch{}
    this.#markAffectTurnFailed(packet,'affect-validation-fallback');
    return this.#coreCapturedCommit(args,output,'affect-'+code);
   }
   throw error;
  }
 }
 #coreCapturedCommit(args,output,reason){
  try{this.store.recordDiagnostic({stage:'affect.capture-core-only',status:'degraded',context:{subjectId:this.subjectId,packetId:args.packet?.packetId},
    data:{reason:String(reason).slice(0,80),meaning:'captured decision adopted through the core session; no affect state is adopted'}});}catch{}
  return this.core.commitCaptured({...args,output:this.#stripAffectOutput(output)});
 }
 async commit(args){
  if(args.packet.payload.internal?.kind==='autonomy')return this.core.commit(args);
  if(this.degraded)return this.#fallbackCommit(args);
  try{return await this.#commitAffect(args);}
  catch(error){if(this.degraded)return this.#fallbackCommit(args);throw error;}
 }
 async #commitAffect(args,{captured=false}={}){
  const {packet}=args;let turn=this.store.read(affectTurnId(packet));
  ensure(turn&&turn.subject===this.subjectId,'AFFECT_TURN','own captured final response required');
  ensure(canonical(packet)===canonical(turn.packet),'AFFECT_PACKET_CHANGED','use the exact stored input');
  const raw=typeof args.output==='string'?args.output:canonical(args.output);
  if(turn.status==='committed'){
   const decision=this.store.read(turn.decision?.id,turn.decision?.revision);
   ensure(decision?.type==='decision'&&decision.id===args.decisionId&&decision.requestKey===args.requestId&&decision.invocationKey===(args.invocationKey??null)&&decision.input.packetId===packet.packetId&&raw===turn.rawOutput,'AFFECT_COMMIT_MISMATCH','completed turn belongs to a different commit');
   return decision;
  }
  ensure(turn.status==='captured','AFFECT_TURN','captured final response required');
  // Real task-source R1 passes decision_attempt.output (the core output with
  // affectAppraisal stripped) while turn.rawOutput is the original model output.
  // Affected appraisal/transition work uses turn.rawOutput; the core commit adopts
  // exactly args.output. Both sides must describe the same captured proposal.
  let affectRaw=raw,corePayload=null;
  if(captured){
   const turnRaw=typeof turn.rawOutput==='string'?turn.rawOutput:canonical(turn.rawOutput);
   let parsed;
   try{parsed=JSON.parse(turnRaw);}catch{const error=Object.assign(new Error('invalid captured JSON; do not repair'),{code:'OUTPUT_JSON'});this.#fail(turn,error,false);throw error;}
   const stripped=copy(parsed);delete stripped.affectAppraisal;
   let expected;
   try{expected=JSON.parse(raw);}catch{const error=Object.assign(new Error('invalid captured JSON; do not repair'),{code:'OUTPUT_JSON'});this.#fail(turn,error,false);throw error;}
   ensure(canonical(stripped)===canonical(expected),'AFFECT_CAPTURE_OUTPUT_MISMATCH','captured decision output must equal the stripped affect output');
   affectRaw=turnRaw;corePayload=args.output;
  }else ensure(raw===turn.rawOutput,'AFFECT_OUTPUT_CHANGED','commit must use captured public output');
  let output;
  try{output=JSON.parse(affectRaw);}catch{const error=Object.assign(new Error('invalid captured JSON; do not repair'),{code:'OUTPUT_JSON'});this.#fail(turn,error,!captured);throw error;}
  let compiled;
  try{compiled=compileIntentOutput({store:this.store,packet,output});}catch(e){this.#fail(turn,e,!captured);throw e;}
  let appraisal;
  try{appraisal=this.fusion?normalizeFusionAppraisal(compiled.affectAppraisal??null,{packet,output:compiled,store:this.store,subjectId:this.subjectId}):normalizeAffectAppraisal(compiled.affectAppraisal??null,packet);}catch(e){this.#fail(turn,e,!captured);throw e;}
  const record=this.store.read(motivationId(this.subjectId));
  ensure(canonical(ref(record))===canonical(turn.preview.baseRef)&&digest(record.snapshot)===turn.preview.baseHash,'STALE_MOTIVATION','base state changed before worker calculation');
  let snapshot=turn.preview.snapshot;const receipts=[];
  const apply=async(channel,source,facts,appraisals,kind='experience')=>{
   const operation={id:channel+':'+digest(source),kind,expectedRevision:snapshot.revision,nowMs:snapshot.wallAt,source:sourceFor(channel,source),...(kind==='experience'?{facts}:{memoryKey:source.memoryKey}),appraisals};
   const r=await this.#workerCall({action:'transition',state:snapshot,operation},'commit');
   validateSnapshot(r.state);ensure(r.receipt?.operationId===operation.id&&r.state.revision===snapshot.revision+1&&r.state.wallAt===snapshot.wallAt&&digest(r.state.config)===digest(record.snapshot.config),'AFFECT_WORKER_BINDING','worker result does not match operation/time/profile');
   snapshot=r.state;receipts.push({channel,originalSource:source,receipt:r.receipt});
  };
  // These are host facts. The model has no field that can set contacts or activity time.
  const event=packet.payload.current,source=event?ref(event):null;
  try{
   if(source&&!hasApplied(snapshot,'facts',source)){
    const sender=event.sender?.entityId,person=sender?this.store.read(sender):null;
    const contacts=person?.type==='entity'&&person.kind==='person'&&['observed','reported'].includes(event.origin)?[sender]:[];
    await apply('facts',source,{contacts,...(turn.hostActivity?{activity:turn.hostActivity}:{})},[]);
   }
   if(appraisal){
    if(!this.fusion||appraisal.mode==='encounter')await apply('appraisal',source,{},appraisal.appraisals);
    else await apply('cognition',{packetId:packet.packetId,mode:appraisal.mode,meaning:appraisal.semanticHash,memoryKey:digest({sources:appraisal.source_refs,...(appraisal.mode==='reappraisal'?{meaning:appraisal.semanticHash}:{})})},null,appraisal.appraisals,'cognitive');
   }
  }catch(e){
   // A deterministic worker can be recomputed from captured data without another model call.
   this.store.recordDiagnostic({stage:'model.failed',status:'failed',context:{subjectId:this.subjectId,packetId:packet.packetId},data:{errorCode:e.code??'AFFECT_WORKER_ERROR'}});throw e;
  }
  const transition={subject:this.subjectId,packetId:packet.packetId,baseRef:turn.preview.baseRef,baseHash:turn.preview.baseHash,
   previewHash:digest(turn.preview.snapshot),appraisalHash:digest(appraisal),snapshot,receipts};
  verifyTransition(transition,{record,packet,output:{affectAppraisal:appraisal},subjectId:this.subjectId});
  const coreOutput=copy(compiled);delete coreOutput.affectAppraisal;
  const write=this.fusion?meaningWrite(appraisal,{subjectId:this.subjectId,packet,decisionId:args.decisionId}):null;
  const extensionWrites=[...(args.extensionWrites??[]),...(write?[write]:[])];
  // CAS of the adopted explanation and engine snapshot is in the same business transaction.
  try{return captured
   ?this.core.commitCaptured({...args,output:corePayload,motivationTransition:transition,affectTurn:ref(turn),extensionWrites})
   :this.core.commit({...args,output:coreOutput,motivationTransition:transition,affectTurn:ref(turn),extensionWrites});}
  catch(e){
   if(['AGENT_CONTROL_CHANGED','AGENT_LEASE_LOST'].includes(e.code))await this.supersede(packet,e);
   else if(isAttentionCapacityError(e.code)){
    // Capacity is a host resource fact, never a model-semantic rejection. Keep the
    // journal at settled+validation=null so the existing deferred/requeue path can
    // re-enter the same source after an operator releases capacity. The turn is
    // marked failed for visibility, but must not be auto-closed/quarantined.
    try{this.store.recordDiagnostic({stage:'affect.capacity-deferred',status:'deferred',context:{subjectId:this.subjectId,packetId:packet.packetId},
      data:{errorCode:e.code,meaning:'host attention capacity; no journal rejection and no affect-state adoption; source remains deferred until explicit requeue'}});}catch{}
    this.#markAffectTurnFailed(packet,'capacity-deferred',e.code);
   }
   else if(e.name==='ContractError')this.#fail(turn,e,!captured);
   throw e;
  }
 }
  readEmotions({offset=0,limit=12}={}){
   ensure(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=64,'AFFECT_PAGE','bounded explicit page');
   const record=this.store.read(motivationId(this.subjectId));ensure(record,'AFFECT_NOT_INITIALIZED','state required');
   const all=completeEmotionProjection(record.snapshot).emotions.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
   return {baseRef:ref(record),asOf:record.snapshot.wallAt,total:all.length,offset,items:all.slice(offset,offset+limit),next:offset+limit<all.length?offset+limit:null};
  }
  sourceBlocked(eventId){if(this.degraded)return this.core.sourceBlocked(eventId);const event=this.store.read(eventId),source=event?{subject:this.subjectId,kind:'event',event:ref(event)}:null;if(source&&this.requestJournal?.sourceRequest(source))return this.requestJournal.blocks(source);return [...this.store.all('affect_turn')].some(t=>t.subject===this.subjectId&&['failed','uncertain','closed-incomplete'].includes(t.status)&&t.packet.payload.current?.id===eventId);}
 closeRejected(args){
  if(this.degraded)return this.core.closeRejected(args);
  if(this.store.read(affectTurnId(args.packet))?.status!=='failed')return false;
  return this.core.closeRejected(args);
 }
 #fail(turn,error,journalReject=true){
  const current=this.store.read(turn.id);if(current?.status!=='captured')return;
  try{this.store.execute({requestId:'affect-fail:'+turn.id+':'+current.revision,commands:[{op:'affect_turn',id:turn.id,expectedRevision:current.revision,status:'failed',error:error.code??'DECISION_REJECTED',failurePhase:'output-validation'}]});}
  catch(recording){error.affectFailureRecording='failed';error.affectFailureError=recording.code??'PERSISTENCE_ERROR';}
  if(journalReject)this.requestJournal?.recordValidation(turn.packet.packetId,{status:'rejected',error:error.code??'DECISION_REJECTED'});
 }
 async run({invoke,requestId,decisionId,...args}){
  if(this.degraded)return this.core.run({invoke,requestId,decisionId,...args});
  const key=digest({requestId,decisionId,args,...(this.fusion?{fusion:true}:{})}),existing=this.store.read(decisionId);
  if(existing){ensure(existing.type==='decision'&&existing.invocationKey===key,'DECISION_ID_COLLISION','different invocation');return {decision:existing,packet:existing.input,resumed:true,modelCalled:false};}
  const packet=await this.prepare(args),turn=this.store.read(affectTurnId(packet)),modelCalled=turn.status==='prepared';
  const output=await this.invoke(packet,invoke),decision=await this.commit({packet,output,requestId,decisionId,invocationKey:key,allowedActionTools:args.allowedActionTools??[],maxOutputBytes:32768});
  return {packet,decision,resumed:!modelCalled,modelCalled};
 }
}

export function affectFactory(options={}){
 const sessions=[];let degraded=null;
 const factory=args=>{
  // Host health wiring may attach a per-session listener at construction time
  // (bootstrap wraps plan.sessionFactory and passes onDegraded per driver).
  const listener=typeof args?.onDegraded==='function'?args.onDegraded:(typeof options.onDegraded==='function'?options.onDegraded:null);
  const report=info=>{degraded=info;try{listener?.(info);}catch{}};
  const session=new AffectSession({...args,...options,onDegraded:report});sessions.push(session);return session;
 };
 factory.status=()=>degraded?{...degraded}:{degraded:false};
 factory.sessions=()=>sessions.slice();
 return factory;
}
