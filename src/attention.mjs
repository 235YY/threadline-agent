// Bounded event topology and residence metadata. Meaning is proposed, not inferred by these rules.
import {canonical,digest,ensure,oneOf,refKey,text,time,uniqueRefs} from './contracts.mjs';
import {advanceWorkbenchFocus,focusWorkbench,validateFocusUse,focusScope,stampFocusBindings} from './focus-workbench.mjs';
import {restoreUse} from './workbench-recovery.mjs';
export const attentionId=subject=>`attention:${digest(subject)}`;
export const PURPOSES=['active-task','affects-current-choice','awaiting-reply','self-directed','recovery-point'];
export const RELATIONS=['task-part-of','during','overlaps','before','causes','contributes-to','affects','supports','challenges','similar','related','realizes'];
// Single source of attention-capacity limits. Only foreground comes from the subject; the
// rest are fixed host resources. Pure constants/derivations: no persistence, no cache, no
// per-channel policy. The write seam remains update_attention -> advanceAttention.
export const ATTENTION_CAPACITY_LIMITS=Object.freeze({
  processes:128,relations:256,questions:64,followups:32,questionAttempts:16,deferrals:32,residenceUpsert:16,restoration:16
});
export const ATTENTION_CAPACITY_CODES=Object.freeze(['FOREGROUND_CAPACITY','ATTENTION_CAPACITY','DEFERRAL_CAPACITY']);
// RESIDENCE_UPSERT_CAPACITY intentionally stays OUT of host-capacity classification: it is a
// typed output/commit-limit refusal (shape/semantic failure like ATTENTION_LIMIT), so it must
// not enter the background capacity gate or the deferred-source lifecycle.
export function isAttentionCapacityError(code){return ATTENTION_CAPACITY_CODES.includes(code);}
// The only model-visible capacity sentence. No numeric used/max is exposed to the subject;
// host-only measurement stays in policy.measure/snapshot.
export const ATTENTION_CAPACITY_HINT='注意力工作区已经满了。外面还有一件事在等你。先看看有没有可以暂时放下的旧事，再处理它。';
export const ATTENTION_CAPACITY_POLICY_FORMAT='jingyang-attention-capacity-policy-v1';
export const ATTENTION_DECISION_KINDS=Object.freeze(['foreground','autonomy','reflection','task','agent']);
const DEFAULT_MAX_FOREGROUND=8;
function foregroundLimit(subjectOrMaxForeground){
  const candidate=subjectOrMaxForeground&&typeof subjectOrMaxForeground==='object'?subjectOrMaxForeground.maxForeground:subjectOrMaxForeground;
  const value=candidate===undefined||candidate===null?DEFAULT_MAX_FOREGROUND:candidate;
  ensure(Number.isSafeInteger(value)&&value>0&&value<=32,'STATE_LIMIT','foreground capacity must be 1..32');
  return value;
}
export function capacityLimits(subjectOrMaxForeground){
  return Object.freeze({foreground:foregroundLimit(subjectOrMaxForeground),...ATTENTION_CAPACITY_LIMITS});
}
// Host-only projection. Never place this object in a model-visible structure.
export function measureAttention(frame,policyOrMaxForeground){
  ensure(frame&&typeof frame==='object','ATTENTION_REQUIRED','attention frame required');
  const supplied=policyOrMaxForeground;
  const limits=supplied?.limits?supplied.limits:supplied&&Number.isSafeInteger(supplied.foreground)?supplied:capacityLimits(supplied);
  const residences=Array.isArray(frame.residences)?frame.residences:[];
  const activeDeferrals=(frame.deferrals??[]).filter(d=>!['restored','cancelled'].includes(d.status)).length;
  const used=residences.length,max=limits.foreground;
  return {used,max,full:used>=max,slots:{
    foreground:{used,max},
    processes:{used:liveProcesses(frame.processes??[]).length,max:limits.processes},
    relations:{used:(frame.relations??[]).length,max:limits.relations},
    questions:{used:(frame.questions??[]).length,max:limits.questions},
    followups:{used:(frame.followups??[]).length,max:limits.followups},
    deferrals:{used:activeDeferrals,max:limits.deferrals}
  }};
}
const defaultResolver=context=>{
  const kind=context?.decisionKind;
  return ATTENTION_DECISION_KINDS.includes(kind)?kind:'reflection';
};
// Service-level singleton: one frozen object for the same subject across all entries.
// resolver(context) resolves the decision kind once per decision; only 'foreground' may
// reclaim a desk entry, all background kinds are fail-closed for reclamation.
export function createAttentionCapacityPolicy({resolver=null}={}){
  ensure(resolver===null||resolver===undefined||typeof resolver==='function','ATTENTION_POLICY_SHAPE','resolver must be a function or null');
  const resolve=context=>{
    const kind=(resolver??defaultResolver)(context??{});
    ensure(ATTENTION_DECISION_KINDS.includes(kind),'ATTENTION_POLICY_SHAPE','resolver must return a known decisionKind');
    return kind;
  };
  return Object.freeze({
    format:ATTENTION_CAPACITY_POLICY_FORMAT,
    hint:ATTENTION_CAPACITY_HINT,
    resolve,
    allowsForegroundRecovery:context=>resolve(context)==='foreground',
    measure:(frame,subjectOrMaxForeground)=>measureAttention(frame,subjectOrMaxForeground),
    snapshot:(frame,subjectOrMaxForeground)=>measureAttention(frame,subjectOrMaxForeground),
    isCapacityError:isAttentionCapacityError
  });
}
export const DEFAULT_ATTENTION_CAPACITY_POLICY=createAttentionCapacityPolicy();
export function normalizeAttentionCapacityPolicy(value){
  if(value===undefined||value===null)return DEFAULT_ATTENTION_CAPACITY_POLICY;
  ensure(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.resolve==='function'
    &&typeof value.allowsForegroundRecovery==='function'&&typeof value.isCapacityError==='function','ATTENTION_POLICY_SHAPE','attentionPolicy must be a normalized policy object');
  return value;
}
// Add-only compatibility aliases for callers that adopted the Phase 0 names first.
export const createAttentionPolicy=createAttentionCapacityPolicy;
export const DEFAULT_ATTENTION_POLICY=DEFAULT_ATTENTION_CAPACITY_POLICY;
const copy=x=>JSON.parse(canonical(x)),ref=x=>({id:x.id,revision:x.revision});
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
const short=(x,n,max=160)=>{text(x,n);ensure([...x].length<=max,'ATTENTION_LIMIT',`${n} too long`);return x;};
const list=(x,n,max=16)=>{ensure(Array.isArray(x)&&x.length<=max,'ATTENTION_LIMIT',`${n} exceeds bound`);return x;};
const exact=(x,keys,n)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&canonical(Object.keys(x).sort())===canonical([...keys].sort()),'ATTENTION_SHAPE',`${n} fields do not match`);
const distinct=(xs,n)=>ensure(new Set(xs.map(x=>x.id)).size===xs.length,'ATTENTION_DUPLICATE',`duplicate ${n}`);
const pin=x=>uniqueRefs([x])[0];
const keys=['processes','relations','residency','questions'];
export function emptyAttention(subject){return {subject,processes:[],relations:[],residences:[],questions:[],followups:[]};}
export function attentionDelta(value){
  exact(value,[...keys,...(Object.hasOwn(value??{},'focus')?['focus']:[]),...(Object.hasOwn(value??{},'deferrals')?['deferrals']:[]),...(Object.hasOwn(value??{},'followups')?['followups']:[]),...(Object.hasOwn(value??{},'eventProcesses')?['eventProcesses']:[])],'attention');
  if(Object.hasOwn(value,'eventProcesses')){
    exact(value.eventProcesses,['add','remove'],'event-process delta');
    const pairs=new Map();
    for(const operation of ['add','remove'])for(const entry of list(value.eventProcesses[operation],operation+' event-process links',16)){
      exact(entry,['event','process'],'event-process link');
      for(const field of ['event','process']){exact(entry[field],['id','revision'],field+' ref');pin(entry[field]);}
      const key=canonical([entry.event,entry.process.id]);
      ensure(!pairs.has(key)||pairs.get(key)===operation,'EVENT_PROCESS_CONFLICT','cannot add and remove the same event-process pair');pairs.set(key,operation);
    }
  }
  if(Object.hasOwn(value,'focus'))exact(value.focus,['select'],'attention focus');
  for(const k of ['processes','relations','questions']){list(value[k],k);distinct(value[k],k);}
  exact(value.residency,['upsert','remove',...(Object.hasOwn(value.residency??{},'restore')?['restore']:[])],'attention residency');list(value.residency.upsert,'residency');distinct(value.residency.upsert,'residency');
  list(value.residency.remove,'residency removals',32).forEach(id=>short(id,'residence id',200));
  if(Object.hasOwn(value.residency,'restore')){list(value.residency.restore,'restores',8);distinct(value.residency.restore,'restores');
    ensure(!value.residency.restore.some(r=>value.residency.remove.includes(r.id)||value.residency.upsert.some(u=>u.id===r.id)),'RESIDENCY_CONFLICT','one operation per binding');}
  ensure(!value.residency.upsert.some(x=>value.residency.remove.includes(x.id)),'RESIDENCY_CONFLICT','cannot add/remove the same residence');
  if(Object.hasOwn(value,'deferrals')){
    exact(value.deferrals,['upsert','restore','cancel',...(Object.hasOwn(value.deferrals??{},'confirm')?['confirm']:[])],'deferrals');
    list(value.deferrals.upsert,'deferral upserts',16);distinct(value.deferrals.upsert,'deferral');
    list(value.deferrals.restore,'deferral restores',16);list(value.deferrals.cancel,'deferral cancels',16);
    if(Object.hasOwn(value.deferrals,'confirm'))list(value.deferrals.confirm,'deferral confirms',16);
    for(const d of value.deferrals.upsert){
      exact(d,['id','ref','condition'],'deferral');
      short(d.id,'deferral id',200);exact(d.condition,['kind','expr'],'deferral condition');
      oneOf(d.condition.kind,['host','subject'],'deferral condition kind');short(d.condition.expr,'deferral condition',400);
    }
    ensure(value.deferrals.restore.every(id=>!value.deferrals.cancel.includes(id)&&!value.deferrals.upsert.some(d=>d.id===id)),'DEFERRAL_CONFLICT','one operation per deferral');
  }
  return copy(value);
}
export const keepAttention=()=>({processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]});

export function activeRelations(frame){return frame.relations.filter(r=>r.status==='active'&&[r.from,r.to].every(e=>same(e,frame.processes.find(p=>p.id===e.id))));}
const hasProcessStatus=(frame,ids,statuses)=>ids.some(id=>frame.processes.some(p=>p.id===id&&statuses.includes(p.status)));
// A purpose may remain recoverable while it is not selected for full delivery.
export function materialPurposeStatus(p,frame,currentEvent){
  if(p.kind==='self-directed')return 'open';
  if(p.kind==='active-task')return hasProcessStatus(frame,p.eventIds,['active'])?'open':hasProcessStatus(frame,p.eventIds,['proposed','paused'])?'parked':'ended';
  if(p.kind==='awaiting-reply'){
    const status=frame.questions.find(q=>q.id===p.questionId)?.status;
    return status==='open'?'open':status==='suspended'?'parked':'ended';
  }
  if(p.kind==='affects-current-choice')return same(p.appliesTo,currentEvent)?'open':'parked';
  return 'parked'; // recovery-point
}
function topology(frame){
  const nodes=new Map(frame.processes.map(p=>[p.id,p])),edges=activeRelations(frame),parents=new Map();
  for(const r of edges){
    const a=nodes.get(r.from.id),b=nodes.get(r.to.id);ensure(a&&b&&a.id!==b.id,'ATTENTION_ENDPOINT','distinct process endpoints required');
    if(r.type==='task-part-of'){
      ensure(a.world===b.world,'BRANCH_MIX','actual and possible containment cannot mix');
      if(!parents.has(a.id))parents.set(a.id,[]);parents.get(a.id).push(b.id);
    }
    if(r.type==='realizes')ensure(a.world==='actual'&&b.world==='possible','BRANCH_MIX','realizes is actual to possible');
  }
  const done=new Set(),visiting=new Set();
  const visit=id=>{ensure(!visiting.has(id),'PART_CYCLE','task containment must be acyclic');if(done.has(id))return;visiting.add(id);for(const p of parents.get(id)??[])visit(p);visiting.delete(id);done.add(id);};
  for(const id of nodes.keys())visit(id);
}

// A process that reached a terminal subject status is a working-graph tombstone: it stays
// in the frame so task/thread evidence can still resolve it, but it no longer consumes the
// live-process capacity. The explicit archive marker/shape beyond terminal status is a
// Lead-owned protocol decision (see phase3.1/impl-u3-b.md interface request).
export const ARCHIVED_PROCESS_STATUSES=Object.freeze(['completed','abandoned']);
export const liveProcesses=processes=>processes.filter(p=>!ARCHIVED_PROCESS_STATUSES.includes(p.status));
export function advanceAttention(previous,raw,env){
  const delta=attentionDelta(raw),next=copy(previous),visible=env.processRefs??[],limits=env.limits??capacityLimits(env.maxForeground);
  ensure(!previous.focus||env.workbenchFocus===true,'FOCUS_CAPABILITY','enabled focus cannot be bypassed');
  ensure(!Object.hasOwn(delta,'focus')||env.workbenchFocus===true,'FOCUS_CAPABILITY','focus patch needs explicit capability');
  const observations=env.observations??[],basisRefs=uniqueRefs([...observations.map(ref),...(env.memoryRefs??[])]);
  for(const change of delta.processes){
    exact(change,['id','expectedRevision','label','body','status','world','intervals','basis'],'process');short(change.id,'process id',200);
    const old=next.processes.find(p=>p.id===change.id);
    ensure(change.expectedRevision===(old?.revision??0),'PROCESS_CONFLICT','process revision changed');
    ensure(!old||visible.some(r=>same(r,old)),'UNREAD_PROCESS','process must have been delivered before revision');
    short(change.label,'process label',100);short(change.body,'process body',1024);
    oneOf(change.status,['proposed','active','paused','completed','abandoned'],'process status');oneOf(change.world,['actual','possible'],'process world');
    ensure(!old||change.world===old.world,'PROCESS_WORLD','create a separate realized process instead of rewriting possibility as fact');
    ensure(change.world!=='possible'||change.status!=='completed','POSSIBILITY_NOT_RECEIPT','possible action is not completed');
    list(change.intervals,'process intervals',8).forEach(i=>{exact(i,['start','end'],'interval');if(i.start!==null)time(i.start);if(i.end!==null)time(i.end);
      ensure(i.start===null||i.end===null||i.end>=i.start,'TIME_ORDER','interval ends before it starts');});
    const basis=uniqueRefs(change.basis);ensure(basis.every(r=>basisRefs.some(b=>same(r,b))),'UNDELIVERED_BASIS','process basis must be a delivered observation/material');
    const value={...copy(change),revision:change.expectedRevision+1,recordedAt:env.at};delete value.expectedRevision;
    if(old)next.processes[next.processes.indexOf(old)]=value;else next.processes.push(value);
  }
  for(const change of delta.relations){
    exact(change,['id','expectedRevision','type','from','to','status','basis'],'relation');short(change.id,'relation id',200);
    const old=next.relations.find(r=>r.id===change.id);ensure(change.expectedRevision===(old?.revision??0),'RELATION_CONFLICT','relation revision changed');
    ensure(!old||(env.relationRefs??[]).some(r=>same(r,old)),'UNREAD_RELATION','read relation before revision');
    oneOf(change.type,RELATIONS,'relation type');oneOf(change.status,['active','retired'],'relation status');
    const from=pin(change.from),to=pin(change.to);ensure(from.id!==to.id&&[from,to].every(e=>next.processes.some(p=>same(p,e))),'ATTENTION_ENDPOINT','new relation pins current distinct process versions');
    const basis=uniqueRefs(change.basis);ensure(basis.every(r=>basisRefs.some(b=>same(r,b))),'UNDELIVERED_BASIS','relation basis must have been delivered');
    const value={...copy(change),from,to,revision:change.expectedRevision+1,recordedAt:env.at};delete value.expectedRevision;
    if(old)next.relations[next.relations.indexOf(old)]=value;else next.relations.push(value);
  }
  next.followups=Array.isArray(next.followups)?next.followups:[];
  for(const change of delta.followups??[]){
    exact(change,['id','processId','targetScene','dueAt','basis'],'followup');
    short(change.id,'followup id',200);short(change.targetScene,'followup target',200);
    ensure(/^qq\/(private|group)\//.test(change.targetScene),'FOLLOWUP_TARGET','followup target must be an explicit qq scene');
    ensure(next.processes.some(p=>p.id===change.processId&&['active','proposed'].includes(p.status)),'FOLLOWUP_PROCESS','followup process must be active or proposed');
    time(change.dueAt);ensure(change.dueAt>env.at&&change.dueAt<=env.at+7*24*60*60*1000,'FOLLOWUP_TIME','followup dueAt must be within seven days');
    const basis=uniqueRefs(change.basis);ensure(basis.length>0&&basis.every(r=>basisRefs.some(b=>same(r,b))),'UNDELIVERED_BASIS','followup basis must be delivered');
    if(typeof env.read==='function'){
      const original=basis.map(r=>env.read(r.id,r.revision)).find(x=>x?.type==='event'&&['observed','reported'].includes(x.origin)&&x.scene===change.targetScene);
      ensure(original,'FOLLOWUP_BASIS','followup target must be an admitted original event in its basis');
    }
    ensure(!next.followups.some(f=>f.id===change.id),'FOLLOWUP_DUPLICATE','followup id already exists');
    next.followups.push({id:change.id,processId:change.processId,targetScene:change.targetScene,dueAt:change.dueAt,status:'scheduled',attempts:0,basis,createdAt:env.at,updatedAt:env.at,lastResponse:null});
  }
  ensure(next.followups.length<=limits.followups,'ATTENTION_CAPACITY','followup limit is thirty-two');
  const live=liveProcesses(next.processes);
  ensure(live.length<=limits.processes&&next.relations.length<=limits.relations,'ATTENTION_CAPACITY','live working graph full; completed/abandoned processes are tombstones and do not count, but new live processes need explicit progress');topology(next);
  for(const change of delta.questions){
    exact(change,['id','expectedRevision','op','text','awaitingResponseFrom','responseEvent'],'question');short(change.id,'question id',200);
    const old=next.questions.find(q=>q.id===change.id);ensure(change.expectedRevision===(old?.revision??0),'QUESTION_CONFLICT','question revision changed');
    ensure(!old||(env.questionRefs??[]).some(r=>same(r,old)),'UNREAD_QUESTION','read question before changing it');
    oneOf(change.op,['open','followup','handle','cancel','suspend','resume'],'question operation');
    if(old)ensure(change.text===old.text&&change.awaitingResponseFrom===old.awaitingResponseFrom,'QUESTION_IDENTITY','followup retains the original question identity');
    else {ensure(change.op==='open','QUESTION_MISSING','new question needs open');short(change.text,'question text',400);short(change.awaitingResponseFrom,'responder',200);}
    const value=old?copy(old):{id:change.id,text:change.text,awaitingResponseFrom:change.awaitingResponseFrom,status:'open',attempts:[],responseEvent:null};
    if(['open','followup'].includes(change.op)){
      ensure(!old||old.status==='open','QUESTION_CLOSED','followup requires an open question');
      ensure(env.responseIntent,'QUESTION_UNSENT','a question attempt needs the selected response intent');
      ensure(change.responseEvent===null,'QUESTION_RESPONSE','sending cannot fabricate an answer');
      ensure(value.attempts.length<limits.questionAttempts,'ATTENTION_CAPACITY','question attempt limit');value.attempts.push(pin(env.responseIntent));
    }else if(change.op==='handle'){
      ensure(['open','suspended'].includes(value.status),'QUESTION_CLOSED','question already closed');
      const answer=pin(change.responseEvent),observation=observations.find(o=>same(o,answer));
      ensure(observation&&['observed','reported'].includes(observation.origin)&&observation.actor===value.awaitingResponseFrom,
        'QUESTION_RESPONSE','answer needs a delivered observation from the expected actor, not a delivery receipt');
      ensure(value.attempts.some(r=>env.read(r.id)?.status==='sent'),'QUESTION_UNSENT','unconfirmed sending cannot be treated as answered');
      value.status='handled';value.responseEvent=answer;
    }else{
      ensure(change.responseEvent===null,'QUESTION_RESPONSE','no answer claimed for lifecycle-only changes');
      const allowed={cancel:['open','suspended'],suspend:['open'],resume:['suspended']};ensure(allowed[change.op].includes(value.status),'QUESTION_TRANSITION','invalid question transition');
      value.status={cancel:'cancelled',suspend:'suspended',resume:'open'}[change.op];
    }
    value.revision=change.expectedRevision+1;value.recordedAt=env.at;
    if(old)next.questions[next.questions.indexOf(old)]=value;else next.questions.push(value);
  }
  ensure(next.questions.length<=limits.questions,'ATTENTION_CAPACITY','working questions full; explicit archival is required');
  if(delta.residency.restore?.length){
    ensure(env.workbenchRecovery===true,'RECOVERY_CAPABILITY','restoration was not enabled');
    const restored=delta.residency.restore.map(r=>restoreUse(r,{frame:next,read:env.read,subject:previous.subject,currentEvent:env.currentEvent,sources:env.recoverySources??[]}));
    delta.residency.upsert.push(...restored);ensure(delta.residency.upsert.length<=limits.residenceUpsert,'RESIDENCE_UPSERT_CAPACITY','combined restoration/upsert exceeds bound');
  }
  for(const id of delta.residency.remove){ensure(next.residences.some(r=>r.id===id),'RESIDENCE_MISSING','cannot remove an unknown residence');
    ensure(!env.residenceIds||env.residenceIds.includes(id),'UNREAD_RESIDENCE','read a residence before removing it');}
  next.residences=next.residences.filter(r=>!delta.residency.remove.includes(r.id));
  for(const change of delta.residency.upsert){
    const material=change.target?.kind==='material';
    exact(change,['id','target','cue','purposes',...(material?['presentation']:[]),...(Object.hasOwn(change,'focusUse')?['focusUse']:[])],'residence');
    ensure(!Object.hasOwn(change,'focusUse')||material&&env.workbenchFocus===true,'FOCUS_CAPABILITY','scoped material use needs focus mode');
    if(Object.hasOwn(change,'focusUse'))focusScope(change.focusUse);
    short(change.id,'residence id',200);short(change.cue,'entry cue',160);
    ensure(!next.residences.some(r=>r.id===change.id)||!env.residenceIds||env.residenceIds.includes(change.id),'UNREAD_RESIDENCE','read a residence before replacing it');
    exact(change.target,['kind','ref'],'target');oneOf(change.target.kind,['state','process','material'],'target kind');const target=pin(change.target.ref);
    const value=change.target.kind==='process'?next.processes.find(p=>same(p,target)):env.read(target.id,target.revision);
    if(material){
      ensure(env.workbenchMaterials===true,'WORKBENCH_CAPABILITY','material residence needs explicit workbench capability');
      oneOf(change.presentation,['full','entry'],'material presentation');
      ensure(value&&['event','note'].includes(value.type),'RESIDENCE_TARGET','material must be a pinned event or note');
      const old=next.residences.find(r=>r.id===change.id);
      ensure((env.memoryRefs??[]).some(r=>same(r,target))||old?.target.kind==='material'&&same(old.target.ref,target),
        'UNREAD_MATERIAL','new material bindings need a complete delivered version, not a directory handle');
    }else{
      ensure(value&&(change.target.kind==='process'||value.type==='personal_state'&&value.subject===previous.subject)
        &&same(value,change.target.kind==='process'?next.processes.find(p=>p.id===target.id):env.read(target.id)),
        'RESIDENCE_TARGET','residence must refer to a current own object');
      ensure(!['closed','completed','abandoned'].includes(value.status),'RESIDENCE_CLOSED','closed target cannot newly reside');
      ensure(change.target.kind==='process'||(env.stateRefs??[]).some(r=>same(r,target))||(env.changedStateIds??[]).includes(target.id),
        'UNREAD_STATE','read or create a state before making it reside');
      ensure(change.target.kind==='state'||visible.some(r=>same(r,target))||delta.processes.some(p=>p.id===target.id),'UNREAD_PROCESS','read or create process before residence');
    }
    list(change.purposes,'purposes',5);ensure(change.purposes.length>0&&new Set(change.purposes.map(p=>p.kind)).size===change.purposes.length,'RESIDENCY_CONFLICT','unique nonempty purposes');
    for(const p of change.purposes){
      exact(p,['kind','eventIds','questionId','appliesTo'],'purpose');oneOf(p.kind,PURPOSES,'purpose');
      list(p.eventIds,'event IDs',8).forEach(id=>ensure(next.processes.some(v=>v.id===id),'ATTENTION_ENDPOINT','purpose refers to an unknown process'));
      ensure(p.kind==='awaiting-reply'?next.questions.some(q=>q.id===p.questionId&&(material?['open','suspended'].includes(q.status):q.status==='open')):p.questionId===null,'QUESTION_MISSING','waiting purpose requires an open question');
      if(p.kind==='affects-current-choice')ensure(same(pin(p.appliesTo),env.currentEvent),'ATTENTION_CONTEXT','choice-affecting purpose must bind to this observation');
      else ensure(p.appliesTo===null,'ATTENTION_CONTEXT','only choice-affecting purposes bind an observation');
      if(p.kind==='active-task'){
        const continuing=next.residences.some(r=>r.id===change.id&&r.target.kind==='material'&&same(r.target.ref,target));
        const usable=material?hasProcessStatus(next,p.eventIds,['active'])||hasProcessStatus(next,p.eventIds,['paused'])&&(change.presentation==='entry'||continuing):
          value.status===(change.target.kind==='process'?'active':'open');
        ensure(usable,'RESIDENCE_INACTIVE','active-task requires an active target or a recoverable material-use process');
      }
    }
    const old=next.residences.find(r=>r.id===change.id);
    const inherited=old?.focusUse&&!Object.hasOwn(change,'focusUse')&&old.target.kind==='material'&&same(old.target.ref,target)?
      {focusUse:copy(old.focusUse),...(old.focusPins?{focusPins:copy(old.focusPins)}:{})}:{};
    const record={...copy(change),...inherited,cueFor:target};if(old)next.residences[next.residences.indexOf(old)]=record;else next.residences.push(record);
  }
  if(env.workbenchFocus)stampFocusBindings(next,previous,delta.residency.upsert);
  for(const r of delta.residency.upsert)if(r.focusUse)validateFocusUse(r.focusUse,next,{...env,changedProcessIds:delta.processes.map(p=>p.id),
    changedResidenceIds:delta.residency.upsert.map(r=>r.id),changedQuestionIds:delta.questions.map(q=>q.id)});
  // Lifecycle changes affect only the target purpose. They never rewrite other nodes or feelings.
  next.residences=next.residences.flatMap(r=>{
    if(r.target.kind==='material'){
      // Material versions are pinned. Pausing an owner parks use; it does not erase the binding.
      ensure(env.read(r.target.ref.id,r.target.ref.revision),'RESIDENCE_TARGET','missing pinned material');
      const purposes=r.purposes.filter(p=>materialPurposeStatus(p,next,env.currentEvent)!=='ended');
      return purposes.length?[{...r,purposes}]:[];
    }
    const value=r.target.kind==='process'?next.processes.find(p=>p.id===r.target.ref.id):env.read(r.target.ref.id);
    ensure(value,'RESIDENCE_TARGET','missing target');if(['closed','completed','abandoned'].includes(value.status))return [];
    const purposes=r.purposes.filter(p=>p.kind!=='active-task'||value.status===(r.target.kind==='process'?'active':'open'))
      .filter(p=>p.kind!=='awaiting-reply'||next.questions.find(q=>q.id===p.questionId)?.status==='open');
    return purposes.length?[{...r,target:{...r.target,ref:ref(value)},purposes}]:[];
  });
  // Opt-in host fallback for foreground turns: the model never sees the
  // foreground count, so a full desk would otherwise reject an otherwise valid
  // reply. A state residence with no process endpoint is only a desk entry: the
  // intent-v1 compiler marks self-authored states as active-task but never binds
  // them to a process, and self-directed states are the same kind of desk line.
  // Drop the oldest ordinary state, never a process, an intention, a residence
  // whose purposes carry process endpoints (any purpose kind, not just
  // active-task), a residence added this turn, or a state updated this turn even
  // when its residence was not re-upserted. The underlying state, Intent and
  // Note are never touched. The generic path stays strict and still refuses
  // silent eviction.
  if(next.residences.length>env.maxForeground&&env.foregroundRecovery===true){
    const excess=next.residences.length-env.maxForeground,added=new Set(delta.residency.upsert.map(r=>r.id));
    const changedStateIds=new Set([...(env.changedStateIds??[]),...(env.changedStateRefs??[]).map(r=>r?.id??r)]);
    const candidates=next.residences.filter(r=>{
      if(r.target.kind!=='state'||added.has(r.id)||changedStateIds.has(r.target.ref.id))return false;
      const purposes=r.purposes??[];
      // A purpose that names process endpoints is a real working binding no matter
      // which kind label it carries; protect it by semantics, not by active-task alone.
      if(purposes.some(p=>(p.eventIds??[]).length>0))return false;
      const value=env.read(r.target.ref.id,r.target.ref.revision);
      return Boolean(value)&&value.kind!=='intention';
    });
    const drop=new Set(candidates.slice(0,excess).map(r=>r.id));
    if(drop.size){
      // Observation hook only: the host may type this as a capacity diagnostic. Never let a
      // diagnostic sink break the transaction, and never let it change the eviction decision.
      try{env.onCapacityEviction?.([...drop]);}catch{}
      next.residences=next.residences.filter(r=>!drop.has(r.id));
    }
  }
  ensure(next.residences.length<=env.maxForeground,'FOREGROUND_CAPACITY','choose residence explicitly; no silent eviction');
  if(delta.deferrals){
    if(!Array.isArray(next.deferrals))next.deferrals=[];
    for(const change of delta.deferrals.upsert){
      const ref=pin(change.ref),material=env.read(ref.id,ref.revision);
      ensure(material&&['event','note'].includes(material.type),'DEFERRAL_TARGET','deferral target must be a material');
      ensure(!next.residences.some(r=>r.target.kind==='material'&&same(r.target.ref,ref)),'DEFERRAL_ACTIVE','deferral target is still resident');
      ensure(!next.deferrals.some(d=>d.id===change.id&&!['restored','cancelled'].includes(d.status)),'DEFERRAL_CONFLICT','deferral id already active');
      ensure(env.memoryRefs===undefined||(env.memoryRefs??[]).some(r=>same(r,ref)),'UNREAD_MATERIAL','deferral needs a delivered material');
      next.deferrals.push({id:change.id,ref,condition:copy(change.condition),conditionType:change.condition.kind,status:'pending',events:[{type:'defer_created',at:env.at??env.read?.clockNow?.()??0}],createdAt:env.at??0});
    }
    for(const id of delta.deferrals.restore){
      const d=next.deferrals.find(x=>x.id===id);ensure(d,'DEFERRAL_MISSING','unknown deferral');
      ensure(d.status==='eligible','DEFERRAL_NOT_ELIGIBLE','deferral condition is not eligible');
      ensure(next.residences.some(r=>r.target.kind==='material'&&same(r.target.ref,d.ref)),'DEFERRAL_RESTORE_TARGET','restore needs the material re-added as a residence');
      d.status='restored';d.events.push({type:'defer_reintroduced',at:env.at??0});
    }
    for(const id of delta.deferrals.cancel){
      const d=next.deferrals.find(x=>x.id===id);ensure(d,'DEFERRAL_MISSING','unknown deferral');
      ensure(!['restored','cancelled'].includes(d.status),'DEFERRAL_STATUS','deferral already terminal');
      d.status='cancelled';d.events.push({type:'defer_cancelled',at:env.at??0});
    }
    for(const id of delta.deferrals.confirm??[]){
      const d=next.deferrals.find(x=>x.id===id);ensure(d,'DEFERRAL_MISSING','unknown deferral');
      ensure(d.condition?.kind==='subject'||d.conditionType==='subject','DEFERRAL_CONDITION','subject can only confirm a subject condition');
      ensure(d.status==='pending','DEFERRAL_STATUS','deferral is not pending');
      d.status='eligible';d.events.push({type:'defer_became_eligible',at:env.at??0,by:'subject'});
    }
    const activeDeferrals=next.deferrals.filter(d=>!['restored','cancelled'].includes(d.status)).length;
    ensure(activeDeferrals<=limits.deferrals,'DEFERRAL_CAPACITY','active deferral cap exceeded');
  }
  return env.workbenchFocus?advanceWorkbenchFocus(next,delta.focus,{...env,changedProcessIds:delta.processes.map(p=>p.id),changedResidenceIds:delta.residency.upsert.map(r=>r.id)}):next;
}

export function normalizeGraphQuery(q){
  exact(q,['seeds','route','maxDepth','maxNodes','offset','need'],'graph query');oneOf(q.route,['directory','parents','children','context','associations'],'graph route');
  list(q.seeds,'graph seeds',8).forEach(id=>short(id,'graph seed',200));short(q.need,'information need',240);
  ensure(Number.isSafeInteger(q.maxDepth)&&q.maxDepth>=0&&q.maxDepth<=4&&Number.isSafeInteger(q.maxNodes)&&q.maxNodes>0&&q.maxNodes<=8
    &&Number.isSafeInteger(q.offset)&&q.offset>=0&&q.offset<=128,'GRAPH_LIMIT','invalid graph budget');
  ensure(q.route==='directory'?q.seeds.length===0:q.seeds.length>0&&q.offset===0,'GRAPH_ROUTE','directory pages or explicit graph seeds required');return {...copy(q),seeds:[...new Set(q.seeds)].sort()};
}
export function expandEvents(frame,query,{maxNodes=8}={}){
  const q=normalizeGraphQuery(query),cap=Math.min(maxNodes,q.maxNodes),nodes=new Map(frame.processes.map(p=>[p.id,p]));
  const edges=activeRelations(frame),selected=new Set(),walk=[],truncated=new Set();let checkedEdges=0;
  if(q.route==='directory'){
    const ordered=[...frame.processes].sort((a,b)=>a.id.localeCompare(b.id)),page=ordered.slice(q.offset,q.offset+cap);
    return {kind:'lookup',frame:ref(frame),query:q,nodes:copy(page),relations:[],truncated:[],nextOffset:q.offset+page.length<ordered.length?q.offset+page.length:null,total:ordered.length};
  }
  q.seeds.forEach(id=>ensure(nodes.has(id),'GRAPH_SEED','unknown seed; use directory to discover IDs'));
  const adjacency=new Map();for(const edge of edges){
    const pairs=q.route==='parents'&&edge.type==='task-part-of'?[[edge.from.id,edge.to.id]]:
      q.route==='children'&&edge.type==='task-part-of'?[[edge.to.id,edge.from.id]]:
      q.route==='associations'&&['similar','related'].includes(edge.type)?[[edge.from.id,edge.to.id],[edge.to.id,edge.from.id]]:
      q.route==='context'&&['during','overlaps','before','causes','contributes-to','affects','supports','challenges','realizes'].includes(edge.type)?[[edge.from.id,edge.to.id],[edge.to.id,edge.from.id]]:[];
    for(const [a,b] of pairs){if(!adjacency.has(a))adjacency.set(a,[]);adjacency.get(a).push({id:b,edge});}
  }
  for(const id of [...new Set(q.seeds)].sort()){if(selected.size===cap){truncated.add('node-limit');break;}selected.add(id);walk.push({id,depth:0});}
  const used=new Map();
  outer:for(let i=0;i<walk.length;i++){
    const current=walk[i],neighbors=(adjacency.get(current.id)??[]).sort((a,b)=>a.id.localeCompare(b.id)||a.edge.id.localeCompare(b.edge.id));
    for(const n of neighbors){
      if(++checkedEdges>256){truncated.add('edge-limit');break outer;}
      if(selected.has(n.id)){used.set(n.edge.id,n.edge);continue;}
      if(current.depth>=q.maxDepth){truncated.add('depth-limit');continue;}
      if(selected.size>=cap){truncated.add('node-limit');continue;}
      selected.add(n.id);walk.push({id:n.id,depth:current.depth+1});used.set(n.edge.id,n.edge);
    }
  }
  return {kind:'lookup',frame:ref(frame),query:q,nodes:[...selected].map(id=>copy(nodes.get(id))),relations:[...used.values()].map(copy),
    truncated:[...truncated].sort(),nextOffset:null,checkedEdges:Math.min(checkedEdges,256)};
}

export function attentionView(frame,{read,currentEvent,workbenchFocus=false,focusProcessIds=[],stateCandidates=[],associationCandidates=[],maxForeground=null}){
  ensure(!frame.focus||workbenchFocus,'FOCUS_CAPABILITY','enabled focus must be explicitly projected');
  const focus=workbenchFocus?focusWorkbench(frame,{read,currentEvent,priorityProcessIds:focusProcessIds,stateCandidates}):null;
  const foreground=[],entries=[],residences=[],materials=[];
  for(const r of frame.residences){
    const value=r.target.kind==='process'?frame.processes.find(p=>same(p,r.target.ref)):read(r.target.ref.id,r.target.ref.revision);
    ensure(value,'RESIDENCE_TARGET','invalid residence projection');
    if(r.target.kind==='material'){
      const focused=focus?.materials.find(m=>m.residenceId===r.id);
      const required=focus?focused?.delivery==='required':r.presentation==='full'&&r.purposes.some(p=>materialPurposeStatus(p,frame,currentEvent)==='open');
      const head=read(r.target.ref.id);
      if(focused?.delivery==='hidden'){residences.push({...copy(r),cueHistorical:false,delivery:'hidden'});continue;}
      residences.push({...copy(r),cueHistorical:false,delivery:required?'required':'entry'});
      materials.push({residenceId:r.id,ref:ref(value),delivery:required?'required':'entry',historical:head?.revision!==value.revision||value.status==='historical',
        ...(head?.revision!==value.revision?{currentHead:ref(head)}:{})});
      continue;
    }
    const required=r.target.kind==='process'&&focus?focus.selectedProcessIds.includes(r.target.ref.id):r.purposes.some(p=>p.kind==='active-task'||p.kind==='awaiting-reply'||p.kind==='affects-current-choice'&&same(p.appliesTo,currentEvent));
    const cueHistorical=!same(r.cueFor??r.target.ref,r.target.ref);
    residences.push({...copy(r),cueHistorical,delivery:required?'required':'entry'});
    if(r.target.kind==='state'&&required)foreground.push(value);
    else if(r.target.kind==='state')entries.push({ref:ref(value),cue:r.cue,cueFor:r.cueFor??r.target.ref,cueHistorical,kind:value.kind,status:value.status});
  }
  const prioritized=[...frame.processes].sort((a,b)=>Number(focus?.selectedProcessIds.includes(b.id)??frame.residences.some(r=>r.target.kind==='process'&&r.target.ref.id===b.id))-Number(focus?.selectedProcessIds.includes(a.id)??frame.residences.some(r=>r.target.kind==='process'&&r.target.ref.id===a.id))||a.id.localeCompare(b.id));
  const processes=prioritized.slice(0,16).map(p=>{
    const required=focus?focus.selectedProcessIds.includes(p.id):residences.some(r=>r.target.kind==='process'&&r.target.ref.id===p.id&&r.delivery==='required');
    return required?copy(p):{id:p.id,revision:p.revision,label:p.label,status:p.status,world:p.world,intervals:p.intervals};
  });
  const ids=new Set(processes.map(p=>p.id)),relations=activeRelations(frame).filter(r=>ids.has(r.from.id)&&ids.has(r.to.id));
  const questions=frame.questions.filter(q=>['open','suspended'].includes(q.status)).map(q=>({...copy(q),attempts:q.attempts.map(a=>{
    const response=read(a.id);ensure(response?.type==='response','QUESTION_RESPONSE','missing response intent');
    return {ref:ref(response),status:response.status,askedAt:response.status==='sent'?response.recordedAt:null,receipts:response.receipts};})}));
  const requiredStates=[...new Map(foreground.map(s=>[refKey(s),s])).values()],requiredKeys=new Set(requiredStates.map(refKey));
  const capacity=Number.isSafeInteger(maxForeground)?measureAttention(frame,maxForeground):null;
  return {foreground:requiredStates,metadata:{frame:ref(frame),kind:'retained-context-not-current-observation',residences,entries:entries.filter(s=>!requiredKeys.has(refKey(s.ref))),processes,relations,questions,
    ...(associationCandidates.length?{associationCandidates,associationMeaning:'automatic-flickers-not-facts-not-read; bodies-not-delivered; cross-scene-pointers-are-labels-only; to inspect use lookup ref or terms'}:{}),
    ...(materials.length?{materials}:{}),...(focus?{focusSupport:focus.metadata}:{}),...(capacity?.full?{capacityHint:ATTENTION_CAPACITY_HINT}:{}),...(frame.deferrals?.length?{deferrals:frame.deferrals.filter(d=>!['restored','cancelled'].includes(d.status))}:{}),...(frame.followups?.length?{followups:frame.followups}:{}),
    directory:{total:frame.processes.length,shown:processes.length,route:'graph.directory'},
    omittedRelations:frame.relations.length-relations.length,
    staleRelations:frame.relations.filter(r=>r.status==='active'&&!activeRelations(frame).some(e=>e.id===r.id))
      .map(r=>({id:r.id,revision:r.revision,type:r.type,from:r.from,to:r.to,needsReview:true}))}};
}
