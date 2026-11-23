import {ensure} from './contracts.mjs';
import {PROACTIVE_DAILY_SOFT_LIMIT,PROACTIVE_FORMAT,proactiveAttemptKey,proactiveDayKey} from './proactive-contact.mjs';

// 主动联系 host 侧纯助手：只接收已持久化的 Decision/Response/Action 记录（调用方从既有
// store 读出后传入），把它们映射成 proactive-contact 模块需要的同日 attemptKey 行；不读
// store、不写任何对象、不新增表/字段、不发送。server 集成时应在任何 claim/send 之前调用，
// 拿返回值直接传给 `authorizeProactiveContact`；账本不完整时必须 fail-closed（0 调用）。
export const PROACTIVE_HOST_FORMAT='jingyang-proactive-host-ledger-v1';
export const PROACTIVE_HOST_TOOL='proactive_contact';
export const PROACTIVE_HOST_GROUP_SCENE_PREFIX='qq/group/';
export const PROACTIVE_HOST_COUNTED_KIND='initiation';
export const PROACTIVE_HOST_UNCOUNTED_KINDS=Object.freeze(['reply','followup','thought','group-peek']);
export const PROACTIVE_HOST_REF_LIMIT=64;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const pinned=ref=>ref!==null&&typeof ref==='object'&&Object.getPrototypeOf(ref)===Object.prototype
  &&typeof ref.id==='string'&&ref.id.length>0&&Number.isSafeInteger(ref.revision)&&ref.revision>0;
const plain=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&!Array.isArray(value);
const refOf=record=>({id:record.id,revision:record.revision});
const sameRef=(a,b)=>pinned(a)&&pinned(b)&&a.id===b.id&&a.revision===b.revision;
const fail=(code,message,details)=>ensure(false,code,message,details);
function refsOf(value,name){
  ensure(Array.isArray(value)&&value.length>0&&value.length<=PROACTIVE_HOST_REF_LIMIT,name+'_SHAPE',name+' must be a bounded nonempty ref array');
  return value.map((ref,index)=>{ensure(pinned(ref),name+'_SHAPE',`${name}[${index}] must pin {id,revision}`);return {id:ref.id,revision:ref.revision};});
}
function decisionOf(entry,index){
  const decision=entry?.decision;
  ensure(plain(decision)&&decision.type==='decision'&&typeof decision.id==='string'&&Number.isSafeInteger(decision.revision)&&Number.isSafeInteger(decision.recordedAt),'PROACTIVE_HOST_DECISION',`entries[${index}] needs a persisted decision`);
  ensure(plain(decision.output)&&Array.isArray(decision.output.options),'PROACTIVE_HOST_DECISION',`entries[${index}].decision.output required`);
  return decision;
}
export function proactiveHostTargetClass(targetScene){
  if(typeof targetScene!=='string')return 'invalid';
  if(targetScene.startsWith(PROACTIVE_HOST_GROUP_SCENE_PREFIX))return 'group';
  return /^qq\/private\/[A-Za-z0-9:_-]{1,80}$/.test(targetScene)?'private':'invalid';
}
function selectedOption(decision){return decision.output.options.find(option=>option.id===decision.output.selected)??null;}
// Persisted reason source: an explicit action arg (immutable, auditable) wins over the
// decision summary. Both are reconstructable from persisted bodies, never from prunable packets.
const reasonOf=(decision,action)=>typeof action?.args?.reason==='string'&&action.args.reason.trim()?action.args.reason.trim():(typeof decision.output.summary==='string'&&decision.output.summary.trim()?decision.output.summary.trim():null);
// 把一条“Decision + 可选 Response/Action”分类：只有显式 proactive_contact Action 是 counted
// initiation；其余 reply/followup/thought/group-peek 一律 uncounted。无法重建/来源不清即抛错，
// 由 builder 转成 complete=false（fail-closed），绝不猜。
export function classifyProactiveHostEntry(entry,{subjectId,timezoneMinutes=480}={}){
  ensure(typeof subjectId==='string'&&subjectId.length>0,'PROACTIVE_SUBJECT','subject id required');
  const decision=decisionOf(entry,0),action=entry.action??null,response=entry.response??null;
  const dayKey=proactiveDayKey({now:decision.recordedAt,timezoneMinutes});
  const currentScene=decision.currentEvent?.scene??null;
  if(action){
    ensure(plain(action)&&action.type==='action'&&typeof action.id==='string'&&Number.isSafeInteger(action.revision),'PROACTIVE_HOST_ACTION','persisted action required');
    ensure(decision.action?.id===action.id,'PROACTIVE_HOST_LINK','action must be the decision own action');
    if(action.tool===PROACTIVE_HOST_TOOL){
      const targetScene=action.args?.targetScene,kind=proactiveHostTargetClass(targetScene);
      ensure(kind!=='invalid','PROACTIVE_HOST_TARGET','proactive_contact needs an explicit qq/private scene');
      ensure(kind!=='group','PROACTIVE_HOST_GROUP_DISABLED','proactive initiation to qq/group is disabled; group peek is read-only',{targetScene});
      const inputRefs=refsOf(action.inputRefs,'PROACTIVE_HOST_INPUT_REFS');
      const reason=reasonOf(decision,action);
      return Object.freeze({kind:PROACTIVE_HOST_COUNTED_KIND,counted:true,dayKey,targetScene,
        actionInputRefs:Object.freeze(inputRefs.map(ref=>Object.freeze({...ref}))),
        attemptKey:proactiveAttemptKey({subjectId,dayKey,kind:PROACTIVE_HOST_COUNTED_KIND,targetScene,reason,sourceRef:refOf(decision)}),
        sourceRef:Object.freeze(refOf(decision)),reason});
    }
    return Object.freeze({kind:action.tool==='group_peek'||action.tool==='channel_control'?'group-peek':(currentScene?'reply':'thought'),
      counted:false,dayKey,targetScene:action.args?.targetScene??null});
  }
  if(response){
    ensure(plain(response)&&typeof response.id==='string'&&sameRef(response.decision,refOf(decision)),'PROACTIVE_HOST_LINK','response must be linked to the decision');
    if(decision.input?.payload?.followup)return Object.freeze({kind:'followup',counted:false,dayKey});
    ensure(currentScene&&response.scene===currentScene,'PROACTIVE_HOST_AMBIGUOUS','a respond without a current source scene cannot be classified; fail closed',{decisionId:decision.id,responseScene:response.scene??null});
    return Object.freeze({kind:'reply',counted:false,dayKey,scene:response.scene});
  }
  const selected=selectedOption(decision);
  ensure(!selected||selected.kind!=='respond','PROACTIVE_HOST_AMBIGUOUS','a respond decision must have its persisted response; fail closed',{decisionId:decision.id});
  return Object.freeze({kind:'thought',counted:false,dayKey});
}
// 把整本（调用方提供的完整窗口）映射为同日 attempt 行。任何一条记录无法分类/重建、重复
// attemptKey、或包含被禁的群主动，都返回 complete=false；server 必须据此停止调用模块。
export function buildProactiveHostLedger({subjectId,entries,dayKey=null,timezoneMinutes=480}={}){
  ensure(typeof subjectId==='string'&&subjectId.length>0,'PROACTIVE_SUBJECT','subject id required');
  ensure(Array.isArray(entries)&&entries.length<=512,'PROACTIVE_HOST_ENTRIES','entries must be a bounded array');
  ensure(dayKey===null||DAY.test(String(dayKey)),'PROACTIVE_DAY','dayKey must be YYYY-MM-DD');
  const attempts=[],uncounted=[],excluded=[],problems=[];
  entries.forEach((entry,index)=>{
    try{
      const row=classifyProactiveHostEntry(entry,{subjectId,timezoneMinutes});
      if(row.counted){(dayKey===null||row.dayKey===dayKey?attempts:excluded).push(Object.freeze({dayKey:row.dayKey,kind:row.kind,attemptKey:row.attemptKey,targetScene:row.targetScene,reason:row.reason,sourceRef:row.sourceRef}));}
      else uncounted.push(Object.freeze({kind:row.kind,dayKey:row.dayKey}));
    }catch(error){problems.push(Object.freeze({index,code:error.code??'PROACTIVE_HOST_ERROR',message:String(error.message??'').slice(0,240)}));}
  });
  const seen=new Set();
  for(const attempt of attempts){
    if(seen.has(attempt.attemptKey))problems.push(Object.freeze({index:null,code:'PROACTIVE_LEDGER_DUPLICATE',message:'duplicate attemptKey in same-day ledger'}));
    seen.add(attempt.attemptKey);
  }
  const complete=problems.length===0;
  return Object.freeze({format:PROACTIVE_HOST_FORMAT,subjectId,dayKey,complete,
    attempts:Object.freeze(attempts),uncounted:Object.freeze(uncounted),excluded:Object.freeze(excluded),problems:Object.freeze(problems),
    limit:PROACTIVE_DAILY_SOFT_LIMIT,
    meaning:'pure host ledger projection; no persistence; incomplete ledger must block model call (fail-closed)'});
}
// server 集成 seam：任何 claim/send 之前调用。校验显式 proactive_contact Action、目标 scene
// （host 层拒绝 qq/group/*）、action.inputRefs 原样精确透传、contextRefs 必须是其精确子集，
// 账本 complete 才返回可喂给 authorizeProactiveContact 的冻结事实；否则抛错、0 调用。
export function assertProactiveHostSend({subjectId,entries,action,dayKey=null,timezoneMinutes=480,contextRefs=null,confirmation=null}={}){
  ensure(plain(action)&&action.type==='action'&&typeof action.id==='string','PROACTIVE_HOST_ACTION','persisted action required');
  // The action being authorized is not yet a prior attempt; project its decision without the
  // action so the module does not flag the current send as a duplicate, while the ledger
  // window still classifies the decision itself.
  const priorEntries=Array.isArray(entries)?entries.map(entry=>entry?.action?.id===action.id?Object.freeze({...entry,action:null}):entry):entries;
  const ledger=buildProactiveHostLedger({subjectId,entries:priorEntries,dayKey,timezoneMinutes});
  ensure(ledger.complete,'PROACTIVE_LEDGER_INCOMPLETE','ledger window is incomplete; fail closed without model call',{problems:ledger.problems});
  ensure(action.tool===PROACTIVE_HOST_TOOL,'PROACTIVE_HOST_TOOL','explicit proactive_contact action required');
  ensure(action.status==='proposed','PROACTIVE_HOST_STATE','only an unexecuted proposed action can be authorized');
  const decisionEntry=Array.isArray(entries)?entries.find(entry=>entry?.action?.id===action.id):null;
  ensure(decisionEntry,'PROACTIVE_HOST_LINK','action must come from the persisted decision window');
  const decision=decisionOf(decisionEntry,0);
  ensure(decision.action?.id===action.id,'PROACTIVE_HOST_LINK','action must be the decision own action');
  const targetScene=action.args?.targetScene,kind=proactiveHostTargetClass(targetScene);
  ensure(kind!=='invalid','PROACTIVE_HOST_TARGET','proactive_contact needs an explicit qq/private scene');
  ensure(kind!=='group','PROACTIVE_HOST_GROUP_DISABLED','proactive initiation to qq/group is disabled; group peek is read-only',{targetScene});
  const actionInputRefs=refsOf(action.inputRefs,'PROACTIVE_HOST_INPUT_REFS');
  const context=contextRefs===null?actionInputRefs:refsOf(contextRefs,'PROACTIVE_HOST_CONTEXT');
  ensure(context.every(ref=>actionInputRefs.some(input=>sameRef(input,ref))),'PROACTIVE_HOST_CONTEXT','context refs must be the exact delivered refs of this action');
  const reason=reasonOf(decision,action);
  const resolvedDay=dayKey??proactiveDayKey({now:decision.recordedAt,timezoneMinutes});
  const attempts=ledger.attempts.filter(attempt=>attempt.dayKey===resolvedDay);
  return Object.freeze({format:PROACTIVE_HOST_FORMAT,subjectId,dayKey:resolvedDay,targetScene,
    actionInputRefs:Object.freeze(actionInputRefs.map(ref=>Object.freeze({...ref}))),
    contextRefs:Object.freeze(context.map(ref=>Object.freeze({...ref}))),
    reason,confirmation:confirmation===null?null:confirmation,
    attempts:Object.freeze(attempts),
    moduleInput:Object.freeze({subjectId,dayKey:resolvedDay,kind:'initiation',targetScene,actionInputRefs:Object.freeze(actionInputRefs.map(ref=>Object.freeze({...ref}))),
      contextRefs:Object.freeze(context.map(ref=>Object.freeze({...ref}))),reason,attempts:Object.freeze(attempts),confirmation:confirmation??undefined}),
    meaning:'host fact set only; pass moduleInput to authorizeProactiveContact, then use existing claim/receipt; never retry automatically'});
}
export const PROACTIVE_HOST_MODULE=Object.freeze({format:PROACTIVE_FORMAT,softLimit:PROACTIVE_DAILY_SOFT_LIMIT});


