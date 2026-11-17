import {ContinuitySession} from '../../src/continuity-session.mjs';
import {prepareReflection} from '../../src/cognition.mjs';
import {canonical,digest,ensure} from '../../src/contracts.mjs';
import {motivationId,affectTurnId,validateSnapshot,normalizeAffectAppraisal,sourceFor,hasApplied} from '../../src/affect-contract.mjs';
import {callWorker} from '../affect-shadow/bridge.mjs';
const ref=x=>({id:x.id,revision:x.revision});
const copy=x=>JSON.parse(canonical(x));

// Complete opt-in session. The worker never receives the store/database path.
export class AffectSession {
 constructor({store,subjectId,attention=true,maxForeground=16,worker=callWorker,config={timezoneMinutes:480,parameters:{}},clock=()=>store.clockNow()}={}){
  Object.assign(this,{store,subjectId,worker,config,clock});this.core=new ContinuitySession({store,subjectId,attention,maxForeground});
 }
 async initialize(nowMs=this.clock()){
  const old=this.store.read(motivationId(this.subjectId));
  if(old){validateSnapshot(old.snapshot);ensure(old.snapshot.config.timezoneMinutes===(this.config.timezoneMinutes??480)&&canonical(old.snapshot.config.parameters)===canonical(this.config.parameters??{}),'AFFECT_PROFILE','explicit new phase required to change profile');return old;}
  const initialized=await this.worker({action:'initialize',nowMs,config:this.config});validateSnapshot(initialized.state);
  return this.store.execute({requestId:'affect-init:'+this.subjectId+':'+digest(this.config),commands:[{op:'initialize_motivation',subjectId:this.subjectId,snapshot:initialized.state}]}).at(-1);
 }
 async #prepare(args,reflection){
  ensure(!args.subjectId||args.subjectId===this.subjectId,'SUBJECT_FIXED','fixed subject');
  const now=args.now??this.clock();await this.initialize(now);
  const keyArgs=copy(Object.fromEntries(Object.entries(args).filter(([k])=>!['store','subjectId','now'].includes(k))));
  const argsKey=digest({reflection,args:keyArgs});
  const pending=[...this.store.all('affect_turn')].filter(t=>t.subject===this.subjectId&&t.status!=='committed');
  ensure(!pending.some(t=>['dispatched','uncertain','failed'].includes(t.status)),'AFFECT_TURN_STOPPED','unconfirmed/rejected model turn blocks new calls; inspect captured evidence');
  const captured=pending.find(t=>t.status==='captured');
  if(captured){ensure(captured.argsKey===argsKey,'AFFECT_CAPTURE_PENDING','finish the captured turn before another task');return captured.packet;}
  const prepared=pending.find(t=>t.status==='prepared'&&t.argsKey===argsKey);
  if(prepared)return prepared.packet;
  const old=this.store.read(motivationId(this.subjectId));
  const advanced=await this.worker({action:'transition',state:old.snapshot,operation:{id:'preview:'+digest({ref:ref(old),now}),kind:'advance',expectedRevision:old.snapshot.revision,nowMs:now}});
  validateSnapshot(advanced.state);ensure(advanced.state.wallAt===now,'AFFECT_WORKER_BINDING','wrong preview time');
  const preview={baseRef:ref(old),baseHash:digest(old.snapshot),snapshot:advanced.state};
  const {hostActivity,...coreArgs}=args;
  if(hostActivity){const event=this.store.read(args.currentEvent?.id,args.currentEvent?.revision);ensure(!reflection&&event?.origin==='tool_receipt'&&[...this.store.all('action')].some(a=>a.receipt?.id===event.id),'AFFECT_ACTIVITY_SOURCE','activity cost requires actual recorded action receipt');}
  const packet=reflection?prepareReflection({...coreArgs,store:this.store,subjectId:this.subjectId,motivationPreview:preview}):this.core.prepare({...coreArgs,motivationPreview:preview});
  const value={subject:this.subjectId,status:'prepared',argsKey,packet,preview,hostActivity:hostActivity??null,rawOutput:null};
  this.store.execute({requestId:'affect-prepare:'+packet.packetId,commands:[{op:'affect_turn',id:affectTurnId(packet),expectedRevision:0,value}]});return packet;
 }
 prepare(args){return this.#prepare(args,false);}
 prepareReflection(args){return this.#prepare(args,true);}
 async invoke(packet,fn){
  let turn=this.store.read(affectTurnId(packet));ensure(turn&&turn.subject===this.subjectId,'AFFECT_TURN','prepared input required');
  if(turn.status==='captured')return turn.rawOutput;
  ensure(turn.status==='prepared','AFFECT_TURN_STOPPED','never automatically resend a dispatched turn');
  turn=this.store.execute({requestId:'affect-dispatch:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'dispatched'}]}).at(-1);
  let raw;
  try{raw=await fn(packet);raw=typeof raw==='string'?raw:canonical(raw);ensure(Buffer.byteLength(raw)<=32768,'AFFECT_OUTPUT_LIMIT','bounded public output');}
  catch(error){this.store.execute({requestId:'affect-uncertain:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'uncertain',error:error.code??'MODEL_ERROR'}]});throw error;}
  this.store.execute({requestId:'affect-capture:'+packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'captured',rawOutput:raw}]});return raw;
 }
 async commit(args){
  const {packet}=args;let turn=this.store.read(affectTurnId(packet));
  ensure(turn?.status==='captured'&&turn.subject===this.subjectId,'AFFECT_TURN','captured final response required');
  const raw=typeof args.output==='string'?args.output:canonical(args.output);
  ensure(raw===turn.rawOutput,'AFFECT_OUTPUT_CHANGED','commit must use captured public output');
  let output;
  try{output=JSON.parse(raw);}catch{this.#fail(turn,'OUTPUT_JSON');ensure(false,'OUTPUT_JSON','invalid captured JSON; do not repair');}
  let appraisal;
  try{appraisal=normalizeAffectAppraisal(output.affectAppraisal??null,packet);}catch(e){this.#fail(turn,e.code??'AFFECT_APPRAISAL');throw e;}
  const record=this.store.read(motivationId(this.subjectId));
  ensure(canonical(ref(record))===canonical(turn.preview.baseRef)&&digest(record.snapshot)===turn.preview.baseHash,'STALE_MOTIVATION','base state changed before worker calculation');
  let snapshot=turn.preview.snapshot;const receipts=[];
  const apply=async(channel,source,facts,appraisals)=>{
   const operation={id:channel+':'+digest(source),kind:'experience',expectedRevision:snapshot.revision,nowMs:snapshot.wallAt,source:sourceFor(channel,source),facts,appraisals};
   const r=await this.worker({action:'transition',state:snapshot,operation});
   validateSnapshot(r.state);ensure(r.receipt?.operationId===operation.id&&r.state.revision===snapshot.revision+1,'AFFECT_WORKER_BINDING','worker result does not match operation');
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
   if(appraisal)await apply('appraisal',source,{},appraisal.appraisals);
  }catch(e){
   // A deterministic worker can be recomputed from captured data without another model call.
   this.store.recordDiagnostic({stage:'model.failed',status:'failed',context:{subjectId:this.subjectId,packetId:packet.packetId},data:{errorCode:e.code??'AFFECT_WORKER_ERROR'}});throw e;
  }
  const transition={subject:this.subjectId,packetId:packet.packetId,baseRef:turn.preview.baseRef,baseHash:turn.preview.baseHash,
   previewHash:digest(turn.preview.snapshot),appraisalHash:digest(appraisal),snapshot,receipts};
  try{return this.core.commit({...args,motivationTransition:transition,affectTurn:ref(turn)});}
  catch(e){this.#fail(turn,e.code??'DECISION_REJECTED');throw e;}
 }
 #fail(turn,error){const current=this.store.read(turn.id);if(current?.status==='captured')this.store.execute({requestId:'affect-fail:'+turn.id+':'+current.revision,commands:[{op:'affect_turn',id:turn.id,expectedRevision:current.revision,status:'failed',error}]});}
 async run({invoke,requestId,decisionId,...args}){
  const key=digest({requestId,decisionId,args}),existing=this.store.read(decisionId);
  if(existing){ensure(existing.type==='decision'&&existing.invocationKey===key,'DECISION_ID_COLLISION','different invocation');return {decision:existing,packet:existing.input,resumed:true,modelCalled:false};}
  const packet=await this.prepare(args),turn=this.store.read(affectTurnId(packet)),modelCalled=turn.status==='prepared';
  const output=await this.invoke(packet,invoke),decision=await this.commit({packet,output,requestId,decisionId,invocationKey:key,allowedActionTools:args.allowedActionTools??[],maxOutputBytes:32768});
  return {packet,decision,resumed:!modelCalled,modelCalled};
 }
}

export function affectFactory(options={}){return args=>new AffectSession({...args,...options});}
