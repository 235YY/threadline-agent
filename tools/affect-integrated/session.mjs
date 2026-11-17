import {readFileSync} from 'node:fs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {prepareReflection} from '../../src/cognition.mjs';
import {canonical,digest,ensure} from '../../src/contracts.mjs';
import {motivationId,affectTurnId,validateSnapshot,normalizeAffectAppraisal,sourceFor,hasApplied,motivationInput,verifyTransition} from '../../src/affect-contract.mjs';
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

// Complete opt-in session. The worker never receives the store/database path.
export class AffectSession {
 constructor({store,subjectId,attention=true,maxForeground=16,worker=callWorker,config={timezoneMinutes:480,parameters:{}},clock=()=>store.clockNow(),fusion=false,requestJournal=null}={}){
  ensure(typeof fusion==='boolean','AFFECT_CONFIG','explicit fusion boolean');Object.assign(this,{store,subjectId,worker,config,clock,fusion,requestJournal});this.core=new ContinuitySession({store,subjectId,attention,maxForeground,requestJournal});
  if(requestJournal)for(const t of store.all('affect_turn')){
   if(t.subject!==subjectId||t.status!=='dispatched')continue;
   const request=requestJournal.packetRequest(t.packet.packetId)??requestJournal.tryFind('turn:'+t.packet.packetId);
   // The bound Journal alone proves a genuinely active model request. Missing
   // or already-ended request facts never prove that this orphan turn succeeded.
   if(request?.status!=='dispatched')
    store.execute({requestId:'affect-interrupted:'+t.id+':'+t.revision,commands:[{op:'affect_turn',id:t.id,expectedRevision:t.revision,status:'uncertain',error:'INTERRUPTED_DISPATCH',failurePhase:'journal-recovery',transportInvoked:null}]});
  }
 }
 async initialize(nowMs=this.clock()){
  const old=this.store.read(motivationId(this.subjectId));
  if(old){verifyProfile(old.snapshot,this.config);return old;}
  const initialized=await this.worker({action:'initialize',nowMs,config:this.config});validateSnapshot(initialized.state);
  return this.store.execute({requestId:'affect-init:'+this.subjectId+':'+digest(this.config),commands:[{op:'initialize_motivation',subjectId:this.subjectId,snapshot:initialized.state}]}).at(-1);
 }
 async #prepare(args,reflection){
  ensure(!args.subjectId||args.subjectId===this.subjectId,'SUBJECT_FIXED','fixed subject');
  const now=args.now??this.clock();await this.initialize(now);
  const keyArgs=copy(Object.fromEntries(Object.entries(args).filter(([k])=>!['store','subjectId','now'].includes(k))));
  const argsKey=digest({reflection,args:keyArgs,...(this.fusion?{fusion:true}:{})});
  const turns=[...this.store.all('affect_turn')].filter(t=>t.subject===this.subjectId);
  const source=requestSource(this.subjectId,args),request=source?this.requestJournal?.sourceRequest(source):null;
  const admitted=request&&(request.status==='reserved'&&request.fingerprint===null||request.status==='settled'&&request.validation?.status==='accepted');
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
  const advanced=await this.worker({action:'transition',state:old.snapshot,operation});
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
 prepare(args){return this.#prepare(args,false);}
 prepareReflection(args){return this.#prepare(args,true);}
 async supersede(packet,error){
  const turn=this.store.read(affectTurnId(packet));if(turn?.status!=='captured')return;
  this.store.execute({requestId:'supersede:'+turn.id,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'superseded',error:error.code??'HOST_CONTROL_CHANGED'}]});
 }
 capturedOutput(packet){const t=this.store.read(affectTurnId(packet));return t?.status==='captured'&&canonical(t.packet)===canonical(packet)?t.rawOutput:null;}
 async invoke(packet,fn){
  let turn=this.store.read(affectTurnId(packet));ensure(turn&&turn.subject===this.subjectId,'AFFECT_TURN','prepared input required');
  ensure(canonical(packet)===canonical(turn.packet),'AFFECT_PACKET_CHANGED','use the exact stored input');
  if(turn.status==='captured')return turn.rawOutput;
  ensure(turn.status==='prepared','AFFECT_TURN_STOPPED','never automatically resend a dispatched turn');
  const others=[...this.store.all('affect_turn')].filter(t=>t.subject===this.subjectId&&t.id!==turn.id);
  ensure(!others.some(t=>['dispatched','captured'].includes(t.status)),'AFFECT_TURN_STOPPED','another actual invocation/capture owns the subject slot');
  const source=turn.requestSource??requestSource(this.subjectId,packet.payload),request=source?this.requestJournal?.sourceRequest(source):null;
  const admitted=request&&(request.status==='reserved'&&request.fingerprint===null||request.status==='settled'&&request.validation?.status==='accepted');
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
 async commit(args){
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
  ensure(raw===turn.rawOutput,'AFFECT_OUTPUT_CHANGED','commit must use captured public output');
  let output;
  try{output=JSON.parse(raw);}catch{const error=Object.assign(new Error('invalid captured JSON; do not repair'),{code:'OUTPUT_JSON'});this.#fail(turn,error);throw error;}
  let appraisal;
  try{appraisal=this.fusion?normalizeFusionAppraisal(output.affectAppraisal??null,{packet,output,store:this.store,subjectId:this.subjectId}):normalizeAffectAppraisal(output.affectAppraisal??null,packet);}catch(e){this.#fail(turn,e);throw e;}
  const record=this.store.read(motivationId(this.subjectId));
  ensure(canonical(ref(record))===canonical(turn.preview.baseRef)&&digest(record.snapshot)===turn.preview.baseHash,'STALE_MOTIVATION','base state changed before worker calculation');
  let snapshot=turn.preview.snapshot;const receipts=[];
  const apply=async(channel,source,facts,appraisals,kind='experience')=>{
   const operation={id:channel+':'+digest(source),kind,expectedRevision:snapshot.revision,nowMs:snapshot.wallAt,source:sourceFor(channel,source),...(kind==='experience'?{facts}:{memoryKey:source.memoryKey}),appraisals};
   const r=await this.worker({action:'transition',state:snapshot,operation});
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
  const coreOutput=copy(output);delete coreOutput.affectAppraisal;
  const write=this.fusion?meaningWrite(appraisal,{subjectId:this.subjectId,packet,decisionId:args.decisionId}):null;
  const extensionWrites=[...(args.extensionWrites??[]),...(write?[write]:[])];
  // CAS of the adopted explanation and engine snapshot is in the same business transaction.
  try{return this.core.commit({...args,output:coreOutput,motivationTransition:transition,affectTurn:ref(turn),extensionWrites});}
  catch(e){if(['AGENT_CONTROL_CHANGED','AGENT_LEASE_LOST'].includes(e.code))await this.supersede(packet,e);else if(e.name==='ContractError')this.#fail(turn,e);throw e;}
 }
  readEmotions({offset=0,limit=12}={}){
   ensure(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=64,'AFFECT_PAGE','bounded explicit page');
   const record=this.store.read(motivationId(this.subjectId));ensure(record,'AFFECT_NOT_INITIALIZED','state required');
   const all=completeEmotionProjection(record.snapshot).emotions.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
   return {baseRef:ref(record),asOf:record.snapshot.wallAt,total:all.length,offset,items:all.slice(offset,offset+limit),next:offset+limit<all.length?offset+limit:null};
  }
  sourceBlocked(eventId){const event=this.store.read(eventId),source=event?{subject:this.subjectId,kind:'event',event:ref(event)}:null;if(source&&this.requestJournal?.sourceRequest(source))return this.requestJournal.blocks(source);return [...this.store.all('affect_turn')].some(t=>t.subject===this.subjectId&&['failed','uncertain','closed-incomplete'].includes(t.status)&&t.packet.payload.current?.id===eventId);}
 closeRejected(args){
  if(this.store.read(affectTurnId(args.packet))?.status!=='failed')return false;
  return this.core.closeRejected(args);
 }
 #fail(turn,error){
  const current=this.store.read(turn.id);if(current?.status!=='captured')return;
  try{this.store.execute({requestId:'affect-fail:'+turn.id+':'+current.revision,commands:[{op:'affect_turn',id:turn.id,expectedRevision:current.revision,status:'failed',error:error.code??'DECISION_REJECTED',failurePhase:'output-validation'}]});}
  catch(recording){error.affectFailureRecording='failed';error.affectFailureError=recording.code??'PERSISTENCE_ERROR';}
  this.requestJournal?.recordValidation(turn.packet.packetId,{status:'rejected',error:error.code??'DECISION_REJECTED'});
 }
 async run({invoke,requestId,decisionId,...args}){
  const key=digest({requestId,decisionId,args,...(this.fusion?{fusion:true}:{})}),existing=this.store.read(decisionId);
  if(existing){ensure(existing.type==='decision'&&existing.invocationKey===key,'DECISION_ID_COLLISION','different invocation');return {decision:existing,packet:existing.input,resumed:true,modelCalled:false};}
  const packet=await this.prepare(args),turn=this.store.read(affectTurnId(packet)),modelCalled=turn.status==='prepared';
  const output=await this.invoke(packet,invoke),decision=await this.commit({packet,output,requestId,decisionId,invocationKey:key,allowedActionTools:args.allowedActionTools??[],maxOutputBytes:32768});
  return {packet,decision,resumed:!modelCalled,modelCalled};
 }
}

export function affectFactory(options={}){return args=>new AffectSession({...args,...options});}
