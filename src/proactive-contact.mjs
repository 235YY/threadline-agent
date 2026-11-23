import {canonical,digest,ensure} from './contracts.mjs';

// 主动联系（proactive contact）纯契约：不读 store、不调模型、不联网、不发送。
// 宿主只在“确实要由主体主动发起一次新的对外联系”时调用本模块；普通回复、内部想法、
// 群内只读观察不占主动联系额度。实际的 Response/Action claim+receipt 仍由现有宿主
// 生命周期持有，本模块只返回冻结的许可事实与重试策略，不写任何持久化对象。
export const PROACTIVE_FORMAT='jingyang-proactive-contact-v1';
export const PROACTIVE_DAILY_SOFT_LIMIT=5;
export const PROACTIVE_COUNTED_KINDS=Object.freeze(['initiation']);
export const PROACTIVE_UNCOUNTED_KINDS=Object.freeze(['reply','thought','group-peek']);
export const PROACTIVE_KINDS=Object.freeze([...PROACTIVE_COUNTED_KINDS,...PROACTIVE_UNCOUNTED_KINDS]);
// 主动联系一旦进入“已发出但结果未知”，不得由宿主自动重发；下一轮必须由主体/operator
// 形成新的显式决定（新的 attemptKey），旧决定只能带证据收为 sent/failed/unknown。
export const PROACTIVE_RETRY_POLICY=Object.freeze({automatic:false,resendOnUnknown:false,newDecisionRequired:true});
const SCENE=/^qq\/(private|group)\/[A-Za-z0-9:_-]{1,80}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const fixedRef=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype
  &&typeof value.id==='string'&&value.id.length>0&&[...value.id].length<=200&&Number.isSafeInteger(value.revision)&&value.revision>0;
const plain=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&!Array.isArray(value);
function prose(value,name,max){ensure(typeof value==='string'&&value.trim().length>0,`${name}_REQUIRED`,`${name} must be nonempty text`);ensure([...value.trim()].length<=max,`${name}_LIMIT`,`${name} longer than ${max}`);return value.trim();}
function optionalProse(value,name,max){if(value===undefined||value===null)return null;return prose(value,name,max);}
function refs(value,name,{min,max}){
  ensure(Array.isArray(value)&&value.length>=min&&value.length<=max,`${name}_SHAPE`,`${name} must contain ${min}..${max} pinned refs`);
  const out=value.map((ref,index)=>{ensure(fixedRef(ref),`${name}_SHAPE`,`${name}[${index}] must pin {id,revision}`);return {id:ref.id,revision:ref.revision};});
  ensure(new Set(out.map(ref=>`${ref.id}@${ref.revision}`)).size===out.length,`${name}_DUPLICATE`,`${name} contains duplicate refs`);
  return out;
}
const sameRef=(a,b)=>a.id===b.id&&a.revision===b.revision;

export function proactiveDayKey({now=Date.now(),timezoneMinutes=480}={}){
  ensure(Number.isSafeInteger(now)&&now>=0,'PROACTIVE_DAY','nonnegative now required');
  ensure(Number.isSafeInteger(timezoneMinutes)&&timezoneMinutes>=-720&&timezoneMinutes<=840,'PROACTIVE_DAY','valid timezone offset required');
  return new Date(now+timezoneMinutes*60*1000).toISOString().slice(0,10);
}
export function countsTowardProactiveBudget(kind){
  ensure(PROACTIVE_KINDS.includes(kind),'PROACTIVE_KIND','unknown proactive kind');
  return PROACTIVE_COUNTED_KINDS.includes(kind);
}
// 宿主必须用同一算法从既有 Response/Action+Decision 账本重建历史 attemptKey，才能检测
// 重复尝试而不新增表/字段。身份只取可长期重建的持久化事实 = 主体+日+种类+目标 scene+
// 理由（宿主用 decision.output.summary）+来源 ref；包内 materials/contextRefs 可能被
// prune，故意不进身份，只在本次许可时校验。
export function proactiveAttemptKey({subjectId,dayKey,kind,targetScene,reason=null,sourceRef=null}){
  ensure(typeof subjectId==='string'&&subjectId.length>0,'PROACTIVE_SUBJECT','subject id required');
  ensure(DAY.test(String(dayKey??'')),'PROACTIVE_DAY','dayKey must be YYYY-MM-DD');
  ensure(PROACTIVE_KINDS.includes(kind),'PROACTIVE_KIND','unknown proactive kind');
  ensure(SCENE.test(String(targetScene??'')),'PROACTIVE_TARGET','explicit qq scene required');
  ensure(reason===null||typeof reason==='string','PROACTIVE_REASON','reason must be text or null');
  ensure(sourceRef===null||fixedRef(sourceRef),'PROACTIVE_SOURCE','source ref must pin {id,revision} or be null');
  return digest({format:PROACTIVE_FORMAT,subjectId,dayKey,kind,targetScene,reason,
    sourceRef:sourceRef?{id:sourceRef.id,revision:sourceRef.revision}:null});
}
function attemptRows(attempts){
  ensure(Array.isArray(attempts)&&attempts.length<=1024,'PROACTIVE_HISTORY','attempts must be a bounded array');
  const rows=attempts.map((attempt,index)=>{
    ensure(plain(attempt),'PROACTIVE_HISTORY',`attempts[${index}] must be an object`);
    ensure(typeof attempt.attemptKey==='string'&&attempt.attemptKey.length>=16&&attempt.attemptKey.length<=128,'PROACTIVE_HISTORY',`attempts[${index}].attemptKey required`);
    ensure(DAY.test(String(attempt.dayKey??'')),'PROACTIVE_HISTORY',`attempts[${index}].dayKey required`);
    ensure(PROACTIVE_KINDS.includes(attempt.kind),'PROACTIVE_HISTORY',`attempts[${index}].kind invalid`);
    return {attemptKey:attempt.attemptKey,dayKey:attempt.dayKey,kind:attempt.kind};
  });
  ensure(new Set(rows.map(row=>row.attemptKey)).size===rows.length,'PROACTIVE_HISTORY_DUPLICATE','attempt history must not repeat an attemptKey');
  return rows;
}
function confirmationFacts(value){
  if(value===undefined||value===null)return null;
  ensure(plain(value),'PROACTIVE_CONFIRMATION','confirmation must be an object');
  ensure(value.approved===true,'PROACTIVE_CONFIRMATION_REQUIRED','host confirmation must be approved');
  const evidence=prose(value.evidence,'PROACTIVE_CONFIRMATION_EVIDENCE',400);
  return Object.freeze({approved:true,byHost:true,evidenceHash:digest(evidence)});
}

export function authorizeProactiveContact(input){
  ensure(plain(input),'PROACTIVE_INPUT','plain input object required');
  ensure(input.automaticRetry!==true,'PROACTIVE_NO_AUTO_RETRY','proactive contact never auto-retries');
  const subjectId=prose(input.subjectId,'PROACTIVE_SUBJECT',200);
  const kind=input.kind??'initiation';
  ensure(PROACTIVE_KINDS.includes(kind),'PROACTIVE_KIND','unknown proactive kind');
  const attempts=attemptRows(input.attempts??[]);
  if(!countsTowardProactiveBudget(kind)){
    if(input.targetScene!==undefined&&input.targetScene!==null)ensure(typeof input.targetScene==='string'&&SCENE.test(input.targetScene),'PROACTIVE_TARGET','explicit qq scene required');
    return Object.freeze({format:PROACTIVE_FORMAT,allowed:true,counted:false,kind,subjectId,
      budget:Object.freeze({limit:PROACTIVE_DAILY_SOFT_LIMIT,soft:true,countedKinds:PROACTIVE_COUNTED_KINDS}),
      retry:PROACTIVE_RETRY_POLICY,
      meaning:'reply/thought/group-peek are not proactive initiations and do not consume the daily soft budget'});
  }
  const dayKey=input.dayKey,now=input.now;
  ensure(DAY.test(String(dayKey??'')),'PROACTIVE_DAY','dayKey must be YYYY-MM-DD');
  if(now!==undefined)ensure(proactiveDayKey({now,timezoneMinutes:input.timezoneMinutes??480})===dayKey,'PROACTIVE_DAY','dayKey does not match now');
  ensure(typeof input.targetScene==='string'&&SCENE.test(input.targetScene),'PROACTIVE_TARGET','explicit qq/private or qq/group scene required');
  const actionInputRefs=refs(input.actionInputRefs,'PROACTIVE_INPUT_REFS',{min:1,max:64});
  const contextRefs=refs(input.contextRefs,'PROACTIVE_CONTEXT',{min:1,max:8});
  ensure(contextRefs.every(ref=>actionInputRefs.some(input=>sameRef(input,ref))),'PROACTIVE_CONTEXT_UNDELIVERED','every context ref must be a delivered input ref of this attempt');
  const used=attempts.filter(attempt=>attempt.dayKey===dayKey&&countsTowardProactiveBudget(attempt.kind)).length;
  const requiresConfirmation=used>=PROACTIVE_DAILY_SOFT_LIMIT;
  const reason=input.reason===undefined||input.reason===null?null:prose(input.reason,'PROACTIVE_REASON',300);
  ensure(!requiresConfirmation||reason!==null,'PROACTIVE_REASON_REQUIRED',`more than ${PROACTIVE_DAILY_SOFT_LIMIT} initiations in one day need a reason`);
  const confirmation=confirmationFacts(input.confirmation);
  ensure(!requiresConfirmation||confirmation!==null,'PROACTIVE_CONFIRMATION_REQUIRED',`more than ${PROACTIVE_DAILY_SOFT_LIMIT} initiations in one day need host confirmation`);
  const sourceRef=input.sourceRef===undefined||input.sourceRef===null?null:refs([input.sourceRef],'PROACTIVE_SOURCE',{min:1,max:1})[0];
  const attemptKey=proactiveAttemptKey({subjectId,dayKey,kind,targetScene:input.targetScene,reason,sourceRef});
  const prior=attempts.find(attempt=>attempt.attemptKey===attemptKey);
  ensure(!prior,'PROACTIVE_DUPLICATE','this proactive attempt identity was already attempted; no automatic retry',{attemptKey,priorDay:prior?.dayKey??null});
  const budget=Object.freeze({used,limit:PROACTIVE_DAILY_SOFT_LIMIT,soft:true,withinSoftBudget:!requiresConfirmation,requiresConfirmation});
  const attempt=Object.freeze({key:attemptKey,ordinal:used+1,subjectId,dayKey,kind,targetScene:input.targetScene,
    contextRefs:Object.freeze(contextRefs.map(ref=>Object.freeze({id:ref.id,revision:ref.revision}))),
    actionInputRefs:Object.freeze(actionInputRefs.map(ref=>Object.freeze({id:ref.id,revision:ref.revision}))),
    reason,confirmation,sourceRef:sourceRef?Object.freeze({id:sourceRef.id,revision:sourceRef.revision}):null});
  return Object.freeze({format:PROACTIVE_FORMAT,allowed:true,counted:true,kind,subjectId,attempt,budget,
    retry:PROACTIVE_RETRY_POLICY,
    meaning:'proactive initiation authorized; host owns Response/Action claim+receipt and must not retry automatically or resend UNKNOWN'});
}
