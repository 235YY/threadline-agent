// Isolated executable reference. No model, network, sender, database, or live migration.
// Persistence in this file means serializable state, NOT a power-loss-safe storage engine.
import {canonical, digest, ensure, oneOf, text, time, uniqueRefs, refKey} from '../../src/contracts.mjs';

const FORMAT='jingyang-state-reference-v1';
const KINDS=['feeling','appraisal','intention','tension','activity'];
const STATUSES=['open','suspended','closed'];
const NATURES=['encounter','reappraisal','self-report','wording','unknown'];
const copy=x=>JSON.parse(canonical(x));
const asRef=x=>({id:x.id,revision:x.revision});
const bytes=x=>Buffer.byteLength(canonical(x),'utf8');
const strings=(xs,name)=>{
  ensure(Array.isArray(xs)&&xs.length<=256,'INPUT_LIMIT',`${name} must be a bounded array`);
  xs.forEach(x=>text(x,name));return [...new Set(xs)].sort();
};
const short=(x,name,max=2048)=>{text(x,name);ensure([...x].length<=max,'INPUT_LIMIT',`${name} too long`);return x;};
const refIn=(r,rs)=>rs.some(x=>refKey(x)===refKey(r));

function validate(state) {
  ensure(state&&state.format===FORMAT,'INVALID_CHECKPOINT','wrong reference format');
  text(state.subject,'subject');ensure(Number.isSafeInteger(state.revision)&&state.revision>=0,'INVALID_CHECKPOINT','invalid checkpoint revision');
  for(const name of ['heads','versions','foreground','observations','turns','requests'])ensure(Array.isArray(state[name]),'INVALID_CHECKPOINT',`invalid ${name}`);
  const keys=new Set(), heads=new Set();
  for(const v of state.versions) {
    const [r]=uniqueRefs([v]);ensure(!keys.has(refKey(r)),'INVALID_CHECKPOINT','duplicate version');keys.add(refKey(r));
    short(v.body,'state body');oneOf(v.kind,KINDS,'state kind');oneOf(v.status,STATUSES,'state status');strings(v.scope,'scope');
    time(v.recordedAt);uniqueRefs(v.ancestryObservations);
  }
  for(const r of state.heads){uniqueRefs([r]);ensure(keys.has(refKey(r))&&!heads.has(r.id),'INVALID_CHECKPOINT','invalid head');heads.add(r.id);}
  const fg=strings(state.foreground,'foreground');ensure(fg.length===state.foreground.length,'INVALID_CHECKPOINT','duplicate foreground id');
  for(const id of fg)ensure(heads.has(id)&&readState(state,id).status!=='closed','INVALID_CHECKPOINT','invalid foreground member');
  const obs=new Set();for(const o of state.observations){text(o.id,'observation id');ensure(o.revision===1&&!obs.has(o.id),'INVALID_CHECKPOINT','invalid observation');obs.add(o.id);short(o.body,'observation body',8192);oneOf(o.origin,['observed','reported','receipt','background'],'observation origin');time(o.recordedAt);}
  const requests=new Set();for(const r of state.requests){text(r.id,'request id');text(r.fingerprint,'request fingerprint');ensure(!requests.has(r.id),'INVALID_CHECKPOINT','duplicate request');requests.add(r.id);}
  return state;
}

export function createState(subject='jingyang-reference') {
  text(subject,'subject');return {format:FORMAT,subject,revision:0,heads:[],versions:[],foreground:[],observations:[],turns:[],requests:[]};
}

export function readState(state,id,revision) {
  const r=revision??state.heads.find(h=>h.id===id)?.revision;
  const found=state.versions.find(v=>v.id===id&&v.revision===r);
  ensure(found,'MISSING_STATE','state version does not exist');return copy(found);
}

export function receive(state,{id,body,origin='reported',recordedAt}) {
  validate(state);text(id,'observation id');short(body,'observation body',8192);time(recordedAt);
  oneOf(origin,['observed','reported','receipt','background'],'observation origin');
  const value={id,revision:1,body,origin,recordedAt},old=state.observations.find(o=>o.id===id);
  if(old){ensure(canonical(old)===canonical(value),'IMMUTABLE_OBSERVATION','observation cannot be rewritten');return copy(state);}
  const next=copy(state);next.observations.push(value);next.revision++;return next;
}

export function pendingObservations(state) {
  const handled=new Set(state.turns.flatMap(t=>t.observations.filter(x=>x.disposition==='handled').map(x=>x.id)));
  return state.observations.filter(o=>!handled.has(o.id)).map(o=>o.id);
}

export function prepare(state,{focus,observationIds=[],extraRefs=[],sourceObservationIds=[],budgetBytes=24000,detail=false}) {
  validate(state);short(focus,'focus',256);
  ensure(typeof detail==='boolean','INVALID_INPUT','detail must be boolean');
  ensure(Number.isSafeInteger(budgetBytes)&&budgetBytes>0,'INPUT_LIMIT','positive byte budget required');
  const getObs=ids=>strings(ids,'observation ids').map(id=>{
    const o=state.observations.find(x=>x.id===id);ensure(o,'MISSING_OBSERVATION','unknown observation');return copy(o);
  });
  const render=v=>detail?v:{id:v.id,revision:v.revision,kind:v.kind,body:v.body,status:v.status,scope:v.scope,nature:v.nature,basisStatus:v.basis===null?'unspecified':'recorded'};
  const observations=getObs(observationIds),foreground=state.foreground.map(id=>render(readState(state,id)));
  const seen=new Set(foreground.map(x=>refKey(x)));
  const extra=uniqueRefs(extraRefs).filter(r=>!seen.has(refKey(r))).map(r=>({
    record:render(readState(state,r.id,r.revision)),role:state.heads.find(h=>h.id===r.id)?.revision===r.revision?'recalled-current-state':'historical-state'
  }));
  const currentIds=new Set(observations.map(x=>x.id));
  const payload={format:'jingyang-state-input-v1',subject:state.subject,checkpoint:state.revision,snapshotHash:digest(state),focus,
    observations,foreground,extra,sourceObservations:getObs(sourceObservationIds).filter(o=>!currentIds.has(o.id)),
    pendingObservationIds:pendingObservations(state)};
  const cost=bytes(payload);
  if(cost>budgetBytes)return {status:'required-overflow',requiredBytes:cost,budgetBytes,unit:'utf8-bytes'};
  return {status:'ok',payload,packetId:digest(payload),bytes:cost,unit:'utf8-bytes'};
}

function checkPacket(state,packet) {
  ensure(packet?.status==='ok'&&packet.packetId===digest(packet.payload),'INVALID_PACKET','input packet was modified');
  ensure(packet.payload.subject===state.subject&&packet.payload.checkpoint===state.revision&&packet.payload.snapshotHash===digest(state),
    'STALE_CHECKPOINT','output belongs to another checkpoint; reread before deciding');
}

function replay(state,id,fingerprint) {
  const old=state.requests.find(r=>r.id===id);if(!old)return null;
  ensure(old.fingerprint===fingerprint,'REQUEST_COLLISION','request id reused with different content');
  return {state:copy(state),record:copy(state.turns.find(t=>t.id===old.turnId)),replayed:true};
}

// All semantic judgments are caller-supplied. Atomic here means a pure all-or-nothing transform.
export function commit(state,packet,request,{recordedAt,maxForeground=8,maxObjects=256}={}) {
  validate(state);time(recordedAt);text(request?.id,'request id');
  const fingerprint=digest({packetId:packet?.packetId,request}),old=replay(state,request.id,fingerprint);if(old)return old;
  checkPacket(state,packet);ensure(request.packetId===packet.packetId,'WRONG_PACKET','wrong decision input');
  ensure(Number.isSafeInteger(maxForeground)&&maxForeground>0&&Number.isSafeInteger(maxObjects)&&maxObjects>0,'INPUT_LIMIT','positive capacities required');
  const changes=request.changes??[];ensure(Array.isArray(changes)&&changes.length<=16,'INPUT_LIMIT','up to sixteen changes');
  const stateRefs=[...packet.payload.foreground.map(asRef),...packet.payload.extra.map(x=>asRef(x.record))];
  const observationRefs=[...packet.payload.observations,...packet.payload.sourceObservations].map(asRef);
  const foreground=new Set(state.foreground),next=copy(state),changed=new Set();
  for(const c of changes) {
    text(c.id,'state id');ensure(!changed.has(c.id),'DUPLICATE_CHANGE','one change per state');changed.add(c.id);
    const head=state.heads.find(h=>h.id===c.id),prev=head?readState(state,c.id):null;
    ensure(Number.isSafeInteger(c.expectedRevision)&&c.expectedRevision===(head?.revision??0),'STATE_CONFLICT','state version changed');
    if(prev)ensure(refIn(asRef(prev),stateRefs),'UNREAD_STATE','old state must be in this input before revision');
    oneOf(c.nature,NATURES,'change nature');short(c.reason,'change reason',512);
    const fields={kind:c.kind??prev?.kind,body:c.body??prev?.body,status:c.status??prev?.status??'open',scope:c.scope??prev?.scope??[]};
    oneOf(fields.kind,KINDS,'state kind');short(fields.body,'state body');oneOf(fields.status,STATUSES,'state status');fields.scope=strings(fields.scope,'scope');
    ensure(!prev||fields.kind===prev.kind,'STATE_IDENTITY','changing kind needs a separate state object');
    const basis=c.basis===undefined||c.basis===null?null:{observations:uniqueRefs(c.basis.observations??[]),priorStates:uniqueRefs(c.basis.priorStates??[])};
    ensure(!basis||basis.observations.every(r=>refIn(r,observationRefs))&&basis.priorStates.every(r=>refIn(r,stateRefs)),
      'UNDELIVERED_BASIS','basis must have been in this input');
    if(c.nature==='encounter')ensure(basis?.observations.some(r=>refIn(r,packet.payload.observations.filter(o=>o.origin!=='background').map(asRef))),
      'ENCOUNTER_REQUIRED','encounter change needs a current delivered observation');
    if(c.nature==='wording')ensure(prev&&fields.kind===prev.kind&&fields.status===prev.status&&canonical(fields.scope)===canonical(prev.scope)
      &&(basis===null||canonical(basis)===canonical(prev.basis)),
      'WORDING_SCOPE','wording cannot change state kind, scope, lifecycle, or evidence basis');
    // New explicitly supplied basis is a recordable change even if the conclusion is unchanged.
    if(prev&&canonical(fields)===canonical({kind:prev.kind,body:prev.body,status:prev.status,scope:prev.scope})
      &&(basis===null||canonical(basis)===canonical(prev.basis)))continue;
    const ancestryObservations=uniqueRefs([...(prev?.ancestryObservations??[]),...(basis?.observations??[]),
      ...(basis?.priorStates??[]).flatMap(r=>readState(state,r.id,r.revision).ancestryObservations)]);
    const value={id:c.id,revision:c.expectedRevision+1,...fields,nature:c.nature,reason:c.reason,basis,
      predecessor:prev?asRef(prev):null,ancestryObservations,recordedAt};
    next.versions.push(value);next.heads=next.heads.filter(h=>h.id!==c.id);next.heads.push(asRef(value));
    if(value.status==='closed')foreground.delete(c.id);else foreground.add(c.id);
  }
  const add=strings(request.residency?.add??[],'foreground additions'),remove=strings(request.residency?.remove??[],'foreground removals');
  ensure(!add.some(id=>remove.includes(id)),'RESIDENCY_CONFLICT','cannot add and remove the same object');
  for(const id of add){const v=readState(next,id);ensure(v.status!=='closed','CLOSED_FOREGROUND','closed state cannot be foreground');foreground.add(id);}
  for(const id of remove){readState(next,id);foreground.delete(id);}
  ensure(next.heads.length<=maxObjects,'STATE_CAPACITY','object bound exceeded; no state was discarded');
  ensure(foreground.size<=maxForeground,'FOREGROUND_CAPACITY','choose explicit background objects before committing');
  next.foreground=[...foreground].sort();
  const processed=request.observations??[];ensure(Array.isArray(processed)&&processed.length<=256,'INPUT_LIMIT','bounded observation handling');
  const ids=new Set();for(const p of processed){text(p.id,'handled observation');ensure(!ids.has(p.id)&&packet.payload.observations.some(o=>o.id===p.id),'UNDELIVERED_OBSERVATION','only current input observations may be handled once');ids.add(p.id);oneOf(p.disposition,['handled','deferred'],'observation handling');}
  const decision=request.decision;ensure(decision&&['respond','lookup','act','continue','pause','wait'].includes(decision.kind)&&decision.payload&&Object.getPrototypeOf(decision.payload)===Object.prototype,'INVALID_DECISION','bounded intent required');
  ensure(bytes(decision)<=8192,'INPUT_LIMIT','decision intent too large');
  let expressionChoice=null;
  if(request.expressionChoice!==undefined&&request.expressionChoice!==null){
    oneOf(request.expressionChoice.mode,['direct','withhold','redirect','mask','unspecified'],'expression choice');
    const reason=request.expressionChoice.reason??null;if(reason!==null)short(reason,'expression reason',512);
    expressionChoice={mode:request.expressionChoice.mode,reason};
  }
  const record={id:request.id,packetId:packet.packetId,inputCheckpoint:state.revision,focus:packet.payload.focus,
    readStates:stateRefs,readObservations:observationRefs,changes:copy(changes),observations:copy(processed),decision:copy(decision),expressionChoice,
    execution:{status:'not-executed',receipt:null},recordedAt};
  next.turns.push(record);next.requests.push({id:request.id,fingerprint,turnId:record.id});next.revision++;
  validate(next);return {state:next,record:copy(record),replayed:false};
}

// Trusted-host boundary in the future adapter; never accepted as model-produced task success.
export function recordDelivery(state,{id,turnId,outcome,source,recordedAt}) {
  validate(state);text(id,'delivery id');text(turnId,'turn id');text(source,'delivery source');time(recordedAt);
  oneOf(outcome,['sent','failed','unknown'],'delivery outcome');
  const fingerprint=digest({id,turnId,outcome,source}),old=replay(state,id,fingerprint);if(old)return old;
  const next=copy(state),turn=next.turns.find(t=>t.id===turnId);ensure(turn,'MISSING_TURN','unknown intent');
  ensure(turn.decision.kind==='respond','NOT_A_SEND','this reference handles only response delivery');
  ensure(turn.execution.status==='not-executed','DELIVERY_RECORDED','do not overwrite delivery history');
  turn.execution={status:'delivery-recorded',receipt:{id,outcome,source,recordedAt}};
  next.requests.push({id,fingerprint,turnId});next.revision++;return {state:next,record:copy(turn),replayed:false};
}

export function readReaction(state,id) {const r=state.turns.find(t=>t.id===id);ensure(r,'MISSING_TURN','unknown reaction');return copy(r);}

export function exportCheckpoint(state) {validate(state);const payload=copy(state);return canonical({payload,digest:digest(payload)});}
export function importCheckpoint(json) {
  ensure(typeof json==='string'&&Buffer.byteLength(json)<=8*1024*1024,'INPUT_LIMIT','bounded reference checkpoint required');
  const envelope=JSON.parse(json);ensure(envelope.digest===digest(envelope.payload),'CHECKPOINT_CHECKSUM','checkpoint content changed');
  return copy(validate(envelope.payload));
}
