import {readFileSync,existsSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {writeLedgerAtomically} from './ledger-io.mjs';
import {ensure,digest,canonical} from './contracts.mjs';
// Execution identity and captured output only; no spending authority or aggregate reserves.
export class RequestJournal {
 constructor(file,{history}={}){this.path=file;this.lock=file+'.lock';mkdirSync(dirname(file),{recursive:true});this.fd=openSync(this.lock,'wx');try{this.data=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{format:'jingyang-request-journal-v1',requests:[]};if(this.data.format!=='jingyang-request-journal-v1'||!Array.isArray(this.data.requests))throw Error('REQUEST_JOURNAL_FORMAT');this.history=new Map((history?JSON.parse(readFileSync(history,'utf8')).requests:[]).map(r=>[r.id,r]));
  let changed=false;for(const r of this.data.requests){
   if(r.status==='dispatched'){r.recovery={from:r.status,reason:'reopened-exclusive-journal; prior transport outcome unknown',at:Date.now()};r.status='uncertain';changed=true;}
   else if(r.status==='reserved'&&r.fingerprint!==null){r.recovery={from:r.status,reason:'reopened-exclusive-journal; dispatch was not registered',at:Date.now()};r.status='released';r.transportInvoked=false;changed=true;}
  }if(changed)this.save();
 }catch(e){this.close();throw e;}}
 save(){ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','closed or failed request journal');try{writeLedgerAtomically(this.path,this.data);}catch(e){this.poisoned=true;throw e;}}
 tryFind(id){return this.data.requests.find(r=>r.id===id)??this.history.get(id)??null;}
 find(id){const r=this.data.requests.find(r=>r.id===id);if(!r)throw Error('REQUEST_NOT_REGISTERED');return r;}
 sourceRequest(source){return this.data.requests.filter(r=>!r.parentRequestId&&r.source&&canonical(r.source)===canonical(source)).at(-1)??null;}
 packetRequest(packetId){return this.data.requests.find(r=>!r.parentRequestId&&r.packetId===packetId)??null;}
 // Task-source recovery primitives (Phase 3.2 R1/R2/R4). Request identity only:
 // these helpers never execute a model request, never adopt an output, and never
 // mutate a journal row besides the existing explicit recordValidation transition.
 taskSource(input={}){
  const {subject,taskId,step}=input??{};
  ensure(typeof subject==='string'&&subject.length>0,'REQUEST_SOURCE','task source subject required');
  ensure(typeof taskId==='string'&&taskId.length>0,'REQUEST_SOURCE','task source taskId required');
  ensure(Number.isSafeInteger(step)&&step>=0,'REQUEST_SOURCE','task source step required');
  return {subject,kind:'task',taskId,step};
 }
 #taskSource(source){
  ensure(source&&source.kind==='task'&&typeof source.subject==='string'&&source.subject.length>0&&
   typeof source.taskId==='string'&&source.taskId.length>0&&Number.isSafeInteger(source.step)&&source.step>=0,
   'REQUEST_SOURCE','canonical task source required');
  return {subject:source.subject,kind:'task',taskId:source.taskId,step:source.step};
 }
 taskSourceRow(source,{packetId=null}={}){
  const s=this.#taskSource(source);
  const rows=this.data.requests.filter(r=>!r.parentRequestId&&r.source&&canonical(r.source)===canonical(s));
  if(packetId!==null){ensure(typeof packetId==='string'&&packetId.length>0,'REQUEST_SOURCE','packet id required');return rows.find(r=>r.packetId===packetId)??null;}
  return rows.at(-1)??null;
 }
 #taskRow(row){
  return row?{id:row.id,status:row.status,packetId:row.packetId??null,fingerprint:row.fingerprint??null,
   validation:row.validation?{status:row.validation.status,error:row.validation.error??null}:null,
   hasOutput:typeof row.output==='string',outputHash:typeof row.output==='string'?digest(row.output):null,
   hasProviderResult:Boolean(row.providerResult),retryAuthorization:row.retryAuthorization??null,
   source:row.source?structuredClone(row.source):null}:null;
 }
 // Read-only operator preview for a task source: latest primary row plus the
 // journal-level blockers. Subject/frame freshness is a store concern and is
 // supplied separately by the caller (assertTaskCaptureAdoptable refsUnchanged).
 inspectTaskSource(source,{packetId=null}={}){
  const s=this.#taskSource(source),row=this.taskSourceRow(s,{packetId});
  return {format:'jingyang-task-source-view-v1',source:structuredClone(s),journal:this.#taskRow(row),
   blocked:this.blocks(s),captureEvidencePresent:Boolean(row&&row.status==='settled'&&row.validation?.status!=='rejected'&&typeof row.output==='string'&&(packetId===null||row.packetId===packetId))};
 }
 // R1/R2 precondition: the exact settled, unrejected, output-bearing packet row for
 // this task source may be re-committed from a durable decision_attempt capture.
 // refsUnchanged must be computed by the caller from the store (subject revision and
 // attention frame revision of the captured packet versus current heads). A stale
 // binding is rejected here before any adoption is attempted.
 assertTaskCaptureAdoptable({packetId,source,refsUnchanged}={}){
  ensure(typeof packetId==='string'&&packetId.length>0,'TASK_CAPTURE_PACKET','packet id required');
  ensure(refsUnchanged===true,'CAPTURE_STALE_REFS','captured packet subject/frame refs changed; operator decision required');
  const s=this.#taskSource(source),row=this.taskSourceRow(s,{packetId});
  ensure(row,'TASK_CAPTURE_NOT_REGISTERED','no journal request is registered for this task packet/source');
  ensure(row.packetId===packetId&&row.source&&canonical(row.source)===canonical(s),'TASK_CAPTURE_SOURCE','journal row belongs to another packet or source');
  ensure(row.status==='settled','TASK_CAPTURE_NOT_SETTLED','only a settled provider request can supply captured output');
  ensure(row.validation?.status!=='rejected','TASK_CAPTURE_REJECTED','model-rejected output must not be adopted');
  ensure(typeof row.output==='string'&&row.output.length>0,'TASK_CAPTURE_OUTPUT_MISSING','journal has no captured output for this packet');
  return {format:'jingyang-task-capture-v1',source:structuredClone(s),row:this.#taskRow(row),alreadyAccepted:row.validation?.status==='accepted'};
 }
 // R4 operator evidence: deterministic, read-only snapshot of the journal fact for
 // an operator close/retry artifact. Closing a task never mutates the journal row.
 taskSourceEvidence(source,{packetId=null,reason=null}={}){
  const s=this.#taskSource(source),row=this.taskSourceRow(s,{packetId});
  const evidence={format:'jingyang-task-source-evidence-v1',source:structuredClone(s),reason:reason??null,
   journal:this.#taskRow(row),blocked:this.blocks(s)};
  return {...evidence,evidenceHash:digest(evidence)};
 }
 bindSource(packetId,source,evidence){
  const r=this.data.requests.find(r=>r.id==='turn:'+packetId);if(!r||r.source)return;
  ensure(evidence?.ref?.id&&Number.isSafeInteger(evidence.ref.revision)&&typeof evidence.packetHash==='string','REQUEST_EVIDENCE','persisted exact packet evidence required');
  r.source=structuredClone(source);r.packetId=packetId;r.sourceEvidence=structuredClone(evidence);this.save();
 }
 blocks(source){const related=this.data.requests.filter(r=>r.source&&canonical(r.source)===canonical(source));if(related.some(r=>r.parentRequestId&&['reserved','dispatched','uncertain'].includes(r.status)))return true;const r=this.sourceRequest(source);return !!r&&!(r.status==='settled'&&(r.validation?.status==='accepted'||r.retryAuthorization))&&!(r.status==='reserved'&&r.fingerprint===null);}
 reserve(id,fingerprint,_quote=null,{source=null,packetId=null,parentRequestId=null}={}){
  const old=this.tryFind(id),same=old?.source&&source&&canonical(old.source)===canonical(source);
  if(old){ensure(old.status==='reserved'&&old.fingerprint===null&&same&&!parentRequestId,'ALREADY_REQUESTED','request already attempted; explicit readmission required');old.fingerprint=fingerprint;old.packetId=packetId;old.boundAt=Date.now();this.save();return;}
  if(source){
   ensure(typeof source.subject==='string'&&typeof source.kind==='string','REQUEST_SOURCE','stable subject and source required');
   const prior=this.sourceRequest(source);
   if(parentRequestId){const parent=this.find(parentRequestId);ensure(parent.status==='settled'&&canonical(parent.source)===canonical(source)&&packetId===parent.packetId&&id===parent.proposalRecovery?.attemptId&&id===`repair:${packetId}:1`&&!this.data.requests.some(r=>r.parentRequestId===parent.id),'REQUEST_SOURCE','only the existing single format-recovery child is allowed');}
   else ensure(!prior||!this.blocks(source),'SOURCE_REQUEST_BLOCKED','source already has an unresolved, unadmitted or rejected request',{requestId:prior?.id,source});
  }
  this.data.requests.push({id,fingerprint,status:'reserved',recordedAt:Date.now(),...(source?{source,packetId,parentRequestId}: {})});this.save();
 }
 dispatch(id){const r=this.find(id);ensure(r.status==='reserved','REQUEST_STATE','reserved request required');ensure(!this.data.requests.some(x=>x.id!==id&&x.status==='dispatched'),'REQUEST_IN_FLIGHT','another request is genuinely in flight');r.status='dispatched';r.dispatchedAt=Date.now();r.transportInvoked=true;this.save();}
 release(id,error=null){const r=this.find(id);ensure(r.status==='reserved','REQUEST_STATE','only an undispatched request can be released');r.status='released';r.transportInvoked=false;r.error=error;this.save();}
 settle(id,usage){const r=this.find(id);if(r.status!=='dispatched')throw Error('REQUEST_STATE');r.status='settled';r.usage=usage;r.actualMicros=usage.upperMicros;r.accountingMeaning='legacy compatibility field is token-rate estimate, NOT official deduction or budget authority';this.save();}
 uncertain(id,error){const r=this.find(id);if(r.status!=='dispatched')throw Error('REQUEST_STATE');r.status='uncertain';r.error=error;this.save();}
 attachOutput(id,output){this.find(id).output=output;this.save();}
 attachProviderResult(id,response){this.find(id).providerResult={complete:response.complete===true,finishReason:response.finishReason,output:response.output,providerResponseId:response.providerResponseId};this.save();}
 recordValidation(packetId,{status,error=null,decision=null}){
  const r=this.packetRequest(packetId);if(!r||r.status!=='settled')return null;
  ensure(['accepted','rejected'].includes(status),'REQUEST_VALIDATION','explicit adoption or rejection required');
  if(r.validation){ensure(r.validation.status===status,'REQUEST_VALIDATION_CONFLICT','cannot replace prior adoption facts');return r;}
  r.validation={status,error,decision,recordedAt:Date.now()};this.save();return r;
 }
 reconcile(id,{evidence,verify}){
  const r=this.find(id);ensure(['dispatched','uncertain'].includes(r.status),'REQUEST_STATE','only an unresolved request can be reconciled');
  ensure(evidence?.requestId===id&&evidence.fingerprint===r.fingerprint&&typeof verify==='function'&&verify(evidence,structuredClone(r))===true,'REQUEST_EVIDENCE','trusted verification bound to the original request required');
  ensure(['not-sent','settled'].includes(evidence.outcome),'REQUEST_EVIDENCE','known outcome required');
  if(evidence.outcome==='settled')ensure(Number.isSafeInteger(evidence.usage?.upperMicros)&&evidence.usage.upperMicros>=0,'REQUEST_EVIDENCE','settlement evidence requires usage');
  r.resolution={evidence:structuredClone(evidence),evidenceHash:digest(evidence),previousStatus:r.status,verifiedAt:Date.now()};
  if(evidence.outcome==='not-sent'){r.status='released';r.transportInvoked=false;}
  else{r.status='settled';r.usage=evidence.usage;r.actualMicros=evidence.usage.upperMicros;if(evidence.providerResult)r.providerResult=structuredClone(evidence.providerResult);}
  this.save();return r;
 }
 readmit(id,{evidence,verify}){
  const r=this.find(id);ensure(!r.parentRequestId&&r.status==='released'&&r.transportInvoked===false,'REQUEST_STATE','explicitly unexecuted primary request required');
  // Task-source retry is blocked (Phase 3.2 R3 not implemented): readmission stays
  // event-source only even if a task row were somehow released.
  ensure(r.source?.kind==='event'&&r.source?.event?.id,'REQUEST_SOURCE','only event-source readmission is supported');
  ensure(evidence?.requestId===id&&typeof verify==='function'&&verify(evidence,structuredClone(r))===true,'REQUEST_EVIDENCE','explicit trusted readmission required');
  const {attempts,...prior}=r;r.attempts=[...(attempts??[]),prior];
  Object.assign(r,{status:'reserved',fingerprint:null,packetId:null,error:null,providerResult:null,output:null,validation:null,proposalRecovery:null,resolution:null,readmission:{evidence:structuredClone(evidence),recordedAt:Date.now()}});this.save();return r;
 }
 authorizeRetry(id,{evidence}={}){
  const r=this.find(id);
  ensure(r.status==='settled'&&r.validation==null&&!r.parentRequestId,'REQUEST_STATE','only a capacity-deferred unvalidated primary request can be retried');
  // R3 task-source second-paid retry is explicitly not implemented. Keep this
  // primitive event-source capacity-only; do not let callers reach it for a task.
  ensure(r.source?.kind==='event','REQUEST_SOURCE','task-source retry is blocked; only event-source capacity requeue is supported');
  ensure(evidence?.kind!=='task-source-retry','REQUEST_SOURCE','task-source retry is blocked');
  ensure(evidence?.requestId===id&&evidence?.capacityReleased===true&&typeof evidence?.operator==='string'&&evidence.operator.length>0,'REQUEST_EVIDENCE','operator authorization and released-capacity evidence required');
  const evidenceHash=digest(evidence);
  // Replaying the same operator evidence is idempotent. New evidence replaces a
  // previous unconsumed authorization (a fresh operator decision supersedes the
  // old one); compensation must revoke by the exact evidenceHash it recorded.
  if(r.retryAuthorization?.evidenceHash===evidenceHash)return {row:r,evidenceHash,alreadyAuthorized:true};
  // Do not leave the in-memory row authorized when the durable write fails: on a
  // save fault the previous in-memory authorization (or its absence) is restored
  // before the error propagates, so a fresh journal read and this instance agree.
  const previous=r.retryAuthorization;
  r.retryAuthorization={evidence:structuredClone(evidence),evidenceHash,recordedAt:Date.now()};
  try{this.save();}
  catch(error){if(previous===undefined)delete r.retryAuthorization;else r.retryAuthorization=previous;throw error;}
  return {row:r,evidenceHash,alreadyAuthorized:false};
 }
 // Compensation for a failed requeue/readmit attempt: removes only the matching
 // unconsumed authorization so the source becomes blocked again. Idempotent when
 // no authorization (or a newer authorization) is present.
 revokeRetry(id,{expectedEvidenceHash=null,reason=null}={}){
  const r=this.find(id),current=r.retryAuthorization;
  if(!current)return {revoked:false,reason:'not-authorized',id};
  if(expectedEvidenceHash!==null&&current.evidenceHash!==expectedEvidenceHash)return {revoked:false,reason:'evidence-mismatch',id,evidenceHash:current.evidenceHash??null};
  const hadRevocation=Object.hasOwn(r,'retryRevocation'),previousRevocation=r.retryRevocation;
  delete r.retryAuthorization;r.retryRevocation={evidenceHash:current.evidenceHash??null,reason:reason??null,revokedAt:Date.now()};
  try{this.save();}
  catch(error){r.retryAuthorization=current;if(hadRevocation)r.retryRevocation=previousRevocation;else delete r.retryRevocation;throw error;}
  return {revoked:true,id,evidenceHash:current.evidenceHash??null};
 }
 // Read-only retry state for operator preview/repair (no mutation).
 inspectRetry(id){
  const r=this.find(id),a=r.retryAuthorization;
  return {format:'jingyang-request-retry-view-v1',id,status:r.status,fingerprint:r.fingerprint??null,
   validation:r.validation?{status:r.validation.status,error:r.validation.error??null}:null,
   authorized:Boolean(a),evidenceHash:a?.evidenceHash??null,evidence:a?structuredClone(a.evidence):null,
   recordedAt:a?.recordedAt??null,blocked:this.blocks(r.source)};
 }
 state(){return {source:'request-identity-journal; official page controls spending',calls:this.data.requests.length,uncertain:this.data.requests.filter(r=>r.status==='uncertain').length,halted:null};}
 refreshDay(){}
 close(){if(this.fd===undefined)return;closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}
}
