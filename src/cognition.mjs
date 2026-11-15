import {readFileSync} from 'node:fs';
import {experienceLearningInput,stageExperienceLessons} from './experience-lessons.mjs';
import {canonical,digest,ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {continuityInput} from './continuity.mjs';
import {normalizeStateDelta} from './personal-state.mjs';
import {withMindInstructions} from './mind-prompt.mjs';
import {normalizeLookupQuery,memoryAspect,sameRef,lookupPolicy,lookupRoundId} from './local-query.mjs';
import {assembleGraphPackages,graphRecordPresent} from './graph-packages.mjs';
import {nodeKey,recordNode} from './knowledge-graph.mjs';
import {stateCard} from './personal-state.mjs';
import {packetContext,failureMetadata,outputMetrics} from './debug-contract.mjs';
import {waitSupportInput,validateWaitCommit} from './wait-support.mjs';
import {consultationDesk} from './consultation-desk.mjs';
import {retrievalAssociations} from './retrieval-association.mjs';
import {capabilityMap} from './capabilities.mjs';
import {normalizeVerbOption} from './verbs.mjs';
import {consultationProgress as progressProjection} from './consultation-progress.mjs';
import {attentionId,attentionView} from './attention.mjs';

const REFLECTION_PROMPT=readFileSync(new URL('../prompts/decision-reflection.zh.md',import.meta.url),'utf8');
const PROMPTS={decision:readFileSync(new URL('../prompts/decision.zh.md',import.meta.url),'utf8'),review:readFileSync(new URL('../prompts/review.zh.md',import.meta.url),'utf8'),
  decisionContinuity:readFileSync(new URL('../prompts/decision-continuity.zh.md',import.meta.url),'utf8'),reflection:REFLECTION_PROMPT};
PROMPTS.decisionInformation=PROMPTS.decisionContinuity.replace('lookup严格二选一：','lookup的基础读取形式为：')+'\n\n'+readFileSync(new URL('../prompts/decision-local-lookup.zh.md',import.meta.url),'utf8');
PROMPTS.decisionWorkbench=PROMPTS.decisionInformation.replace('每项必须含id、expectedRevision、nature、reason；可含kind、body、status、scope、basis。',
  '每项必须含id、expectedRevision、nature；可含kind、body、status、scope、basis、reason。reason可省略或为null，表示未提供修改理由；不必编造理由来完成状态保存。')+
  '\n\n'+readFileSync(new URL('../prompts/decision-memory-access.zh.md',import.meta.url),'utf8');
PROMPTS.decisionAttention=PROMPTS.decisionWorkbench.replace('continuity严格包含changes、residency、expressionChoice、observationDisposition。',
  'continuity严格包含changes、residency、expressionChoice、observationDisposition、attention。').replace(
  '- residency严格含add和remove两个对象ID数组。修改中的开放对象会进入前台；需要放后台的明确列入remove。退到后台不删内容，不是忘掉。closed对象自动退出前台。前台容量由输入maxForeground给出，不能扩大权限。',
  '- residency严格为{"add":[],"remove":[]}，本阶段只通过attention.residency修改用途驻留，保存状态不自动加入前台。')+
  '\n\n'+readFileSync(new URL('../prompts/decision-attention.zh.md',import.meta.url),'utf8');
PROMPTS.decisionMind=withMindInstructions(PROMPTS.decisionAttention);
const GRAPH_READ_PROMPT=readFileSync(new URL('../prompts/decision-graph.zh.md',import.meta.url),'utf8');
PROMPTS.decisionGraph=PROMPTS.decisionMind+'\n\n'+GRAPH_READ_PROMPT;
const CONSULT_PROMPT=readFileSync(new URL('../prompts/decision-consultation.zh.md',import.meta.url),'utf8');
const MATERIAL_PROMPT=readFileSync(new URL('../prompts/decision-workbench-materials.zh.md',import.meta.url),'utf8');
const FOCUS_PROMPT=readFileSync(new URL('../prompts/decision-workbench-focus.zh.md',import.meta.url),'utf8');
const RECOVERY_PROMPT=readFileSync(new URL('../prompts/decision-workbench-recovery.zh.md',import.meta.url),'utf8');
const SELF_PROTOCOL=readFileSync(new URL('../prompts/decision-self-protocol.zh.md',import.meta.url),'utf8');
const MEMORY_PROTOCOL=readFileSync(new URL('../prompts/memory-protocol.zh.md',import.meta.url),'utf8');
const SILENCE_PROTOCOL=readFileSync(new URL('../prompts/silence-protocol.zh.md',import.meta.url),'utf8');
const ALGORITHM_V011_PROMPT=readFileSync(new URL('../prompts/algorithm-v011.zh.md',import.meta.url),'utf8');
const APPERCEPTION_V1_PROMPT=readFileSync(new URL('../prompts/apperception-v1.zh.md',import.meta.url),'utf8');
const DOMAIN_PROMPT=readFileSync(new URL('../prompts/decision-domains.zh.md',import.meta.url),'utf8');
const SUBJECTIVE_MEMORY_PROMPT=readFileSync(new URL('../prompts/subjective-memory.zh.md',import.meta.url),'utf8');
const SUBJECTIVE_MEMORY_V2_PROMPT=readFileSync(new URL('../prompts/subjective-memory-v2.zh.md',import.meta.url),'utf8');
const TASK_THREADS_PROMPT=readFileSync(new URL('../prompts/task-threads.zh.md',import.meta.url),'utf8');
const MEMORY_UPDATE_PROMPT='这段时间有新经历。是否要把值得留下的写成自己的记忆，由你决定：可以用 do("remember_note", {body, kind?, scene?}) 记一笔；不记、跳过也完全可以。不要为了完成任务而编造记忆。';
const EXPERIENCE_LEARNING_PROMPT=readFileSync(new URL('../prompts/experience-learning-v1.zh.md',import.meta.url),'utf8');
const ANTI_ASSISTANT=readFileSync(new URL('../prompts/anti-assistant.zh.md',import.meta.url),'utf8');
const ASPECTS=['experience','feeling','belief','goal','knowledge'];
const KINDS=['respond','lookup','act','continue','pause','wait','intent','none'];
const clone=x=>JSON.parse(canonical(x));
const asRef=x=>({id:x.id,revision:x.revision});
function exact(x,keys,name) {
  ensure(x && Object.getPrototypeOf(x)===Object.prototype && canonical(Object.keys(x).sort())===canonical([...keys].sort()),'OUTPUT_SHAPE',`${name} fields do not match protocol`);
}
function short(value,name,limit=400) {text(value,name);ensure([...value].length<=limit,'OUTPUT_LIMIT',`${name} too long`);return value;}
function bound(bytes,name) {ensure(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=131072,'INVALID_BUDGET',`${name} must be 1..131072 bytes`);}
function record(store,ref,types) {
  uniqueRefs([ref]);const r=store.read(ref.id,ref.revision);
  ensure(r&&types.includes(r.type),'REFERENCE_TYPE','missing or incorrect reference',ref);return r;
}
function materialList(store,assignments,heads=false) {
  ensure(Array.isArray(assignments)&&assignments.length<=32,'INPUT_LIMIT','up to 32 explicit material assignments');
  const map=new Map();
  for(const a of assignments) {
    uniqueRefs([a.ref]);ensure(ASPECTS.includes(a.aspect),'INVALID_ASPECT','unknown personal material aspect');
    const key=refKey(a.ref), r=record(store,a.ref,['event','note']);
    if(!map.has(key))map.set(key,{ref:asRef(r),aspects:[],record:r,historical:store.read(r.id).revision!==r.revision||r.status==='historical',needsReview:store.basisChanged(asRef(r))});
    if(!map.get(key).aspects.includes(a.aspect))map.get(key).aspects.push(a.aspect);
  }
  return [...map.values()].map(m=>({...m,aspects:m.aspects.sort(),...(heads&&store.read(m.ref.id).revision!==m.ref.revision?
    {currentHead:{ref:asRef(store.read(m.ref.id)),meaning:'pointer-only-not-delivered-body; current-is-not-necessarily-correct'}}:{})})).sort((a,b)=>refKey(a.ref)<refKey(b.ref)?-1:refKey(a.ref)>refKey(b.ref)?1:0);
}
// Keep chronological entries, but reference a whole pinned body already present in this packet.
function linkRepeatedRecentBodies(data){
  const recent=data.continuity?.recent;if(!recent)return data;
  const full=new Map();
  if(data.current?.type==='event')full.set(refKey(data.current),{path:'current',ref:asRef(data.current)});
  for(const material of data.materials??[])if(material.record?.type==='event')full.set(refKey(material.ref),{path:'materials',ref:material.ref});
  recent.items=recent.items.map(item=>{
    const bodySource=full.get(refKey(item.ref));if(!bodySource)return item;
    const {text,...legacyTimeline}=item;
    // The exact structured message is already on the same pinned event too.
    // New packets reference it instead of carrying a second verbatim copy.
    const timeline={...legacyTimeline};if(data.continuity?.capabilities?.contractVersion===2)delete timeline.message;
    return {...timeline,bodySource,representation:'same-version-body-already-delivered'};
  });
  return data;
}
// Only oldest unselected timeline text is delivered as an explicit directory
// entry when needed. All fixed-version current/material evidence stays intact.
export function boundedTimeline(data,instruction,budgetBytes){
 if(data.continuity?.capabilities?.contractVersion!==2||budgetBytes<32768)return data;
 const recent=data.continuity.recent;if(!recent?.items)return data;
 const target=budgetBytes-8192,size=()=>Buffer.byteLength(canonical([{role:'system',content:instruction},{role:'user',content:canonical({packetId:'0'.repeat(64),...data})}]));
 for(let n=0;n<recent.items.length&&size()>target;n++){
  const item=recent.items[n];if(item.bodySource||(!Object.hasOwn(item,'text')&&!Object.hasOwn(item,'message')))continue;
  const {text,message,...entry}=item,replacement={...entry,representation:'entry-only-budget',bodyDelivery:{source:item.ref,fullBodyDelivered:false,meaning:'旧时间线正文此次未交付；原固定版本仍保存，可通过现有lookup查阅'}};
  if(Buffer.byteLength(canonical(replacement))<Buffer.byteLength(canonical(item)))recent.items[n]=replacement;
 }
 return data;
}
// Large list receipts remain intact in Store. Deliver complete list entries as
// an explicitly partial page so an oversized read result cannot block the inbox.
// This is transport pagination, never a model-written summary or a new fact.
function pageCurrentReceipt(data){
  const current=data.current;
  if(current?.origin!=='tool_receipt'||typeof current.body!=='string'||Buffer.byteLength(current.body)<=16000)return data;
  let rows;try{rows=JSON.parse(current.body);}catch{return data;}
  if(!Array.isArray(rows))return data;
  const items=[];let bytes=2;
  for(const row of rows){const size=Buffer.byteLength(canonical(row))+(items.length?1:0);if(items.length===32||bytes+size>12000)break;items.push(row);bytes+=size;}
  data.current={...current,body:canonical(items),representation:'bounded-tool-receipt-array-page',bodyDelivery:{
    source:asRef(current),sourceBodyFingerprint:digest(current.body),originalBytes:Buffer.byteLength(current.body),
    offset:0,count:items.length,total:rows.length,nextOffset:items.length<rows.length?items.length:null,
    fullBodyDelivered:false,meaning:'complete list entries from pinned receipt; omitted entries were not delivered; full original receipt remains stored; read tools may provide subsequent pages'}};
  return data;
}
function seal(stage,payload,budgetBytes,instructionSuffix=null) {
  bound(budgetBytes,'input budget');
  const focused=payload.continuity?.attention?.focusSupport?.enabled===true;
  let baseInstruction=focused?PROMPTS[stage].replace('continuity在原四字段以外还必须有attention，严格为：','continuity在原四字段以外还必须有attention；基本字段如下，另可含focus：'):PROMPTS[stage];
  if(payload.continuity?.attention?.recoverySupport?.enabled)baseInstruction=baseInstruction.replace('另可含focus：','另可含focus，residency另可含restore：');
  const instruction=baseInstruction+(payload.memoryAccess?.historyRecovery?.enabled?'\n\n'+GRAPH_READ_PROMPT:'')+(instructionSuffix?'\n\n'+instructionSuffix:'')+(payload.memoryAccess?.consultation?.enabled?'\n\n'+CONSULT_PROMPT:'')+
    (payload.continuity?.attention?.materialSupport?.enabled&&!focused?'\n\n'+MATERIAL_PROMPT:'')+
    (payload.continuity?.attention?.focusSupport?.enabled?'\n\n'+FOCUS_PROMPT:'')+
    (payload.continuity?.attention?.recoverySupport?.enabled?'\n\n'+RECOVERY_PROMPT:'')+
    (payload.waitSupport?'\n本轮启用waitSupport。选择wait时payload必须明确为{mode:"park"}、{mode:"next-event"}、{mode:"until",wakeAt:未来毫秒}，或仅在sources有值时用{mode:"feedback",source:"实际W短名",wakeAt:未来毫秒}。deadline不得超过maxWakeAt。不写mode不能提交。反馈只能等已交付来源，提出动作不代表已经开工；无来源可自主观察、尝试、暂放或等新消息，不必强迫行动。超时只重新评估，不能当作回答或成功。':'')+
    (payload.continuity?.selfProtocol?.enabled===true?'\n\n'+SELF_PROTOCOL:'')+
    (payload.continuity?.memoryProtocol?.enabled===true?'\n\n'+MEMORY_PROTOCOL:'')+
    (payload.continuity?.silenceProtocol?.enabled===true?'\n\n'+SILENCE_PROTOCOL:'')+
    (payload.memoryUpdate?.due===true?'\n\n'+MEMORY_UPDATE_PROMPT:'')+
    (payload.experienceLearning?.enabled===true?'\n\n'+EXPERIENCE_LEARNING_PROMPT:'')+
    (payload.algorithmV011?.enabled===true?'\n\n'+ALGORITHM_V011_PROMPT:'')+
    (payload.apperceptionV1?.enabled===true?'\n\n'+APPERCEPTION_V1_PROMPT:'')+
    (payload.subjectiveDomains?.enabled===true?'\n\n'+DOMAIN_PROMPT:'')+
    (payload.subjectiveMemory?.enabled===true?'\n\n'+SUBJECTIVE_MEMORY_PROMPT:'')+
    (payload.subjectiveMemoryV2?.enabled===true?'\n\n'+SUBJECTIVE_MEMORY_V2_PROMPT:'')+
    (payload.taskThreads?.enabled===true?'\n\n'+TASK_THREADS_PROMPT:'')+
    (payload.task?'\n\n【任务步】当前是主体自己的长链任务。你可以选择工具，或用 task_finish/task_blocked/task_help/task_pause/task_wait/task_replan/task_redirect 这些控制工具；不要声称工具已执行，观察由宿主返回。': '')+
    (payload.style?.text?'\n\n'+ANTI_ASSISTANT+'\n\n【她自己的说话方式】\n'+payload.style.text:'')+
    (payload.continuity?.capabilities?.enabled?.length?'\n\n'+capabilityMap({enabled:payload.continuity.capabilities.enabled,...([1,2].includes(payload.continuity.capabilities.contractVersion)?{allowedActionTools:payload.allowedActionTools,task:!!payload.task,contractVersion:payload.continuity.capabilities.contractVersion}:{})}).text:''), data=boundedTimeline(linkRepeatedRecentBodies(clone(payload)),instruction,budgetBytes), packetId=digest({stage,instruction,payload:data});
  const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,...data})}];
  const bytes=Buffer.byteLength(canonical(messages),'utf8');
  ensure(bytes<=budgetBytes,'INPUT_OVERFLOW','complete model messages exceed byte budget',{requiredBytes:bytes,budgetBytes,instructionBytes:Buffer.byteLength(instruction),payloadBytes:Buffer.byteLength(canonical(data))});
  return {stage,packetId,payload:data,...(instructionSuffix?{instructionSuffix}:{}),instruction,messages,bytes,budgetBytes,unit:'utf8-bytes'};
}
function verify(packet,stage) {
  ensure(packet?.stage===stage,'PACKET_STAGE','wrong packet stage');
  const rebuilt=seal(stage,packet.payload,packet.budgetBytes,packet.instructionSuffix??null);
  ensure(rebuilt.packetId===packet.packetId && canonical(rebuilt.messages)===canonical(packet.messages)
    && packet.instruction===rebuilt.instruction && packet.bytes===rebuilt.bytes,'PACKET_CHANGED','use the exact host-prepared packet');
}
function parse(output,maxOutputBytes) {
  bound(maxOutputBytes,'output budget');
  const raw=typeof output==='string'?output:canonical(output);
  ensure(Buffer.byteLength(raw,'utf8')<=maxOutputBytes,'OUTPUT_OVERFLOW','model output exceeds bound');
  try{return JSON.parse(raw);}catch{ensure(false,'OUTPUT_JSON','valid JSON required');}
}
function permitted(tools) {
  ensure(Array.isArray(tools)&&tools.length<=64,'INPUT_LIMIT','up to 64 granted action tools');tools.forEach(t=>text(t,'tool'));
  return [...new Set(tools)].sort();
}
function inputRefs(payload) {return payload.materials.map(m=>({ref:m.ref,historical:m.historical}));}
const continuityStage=stage=>['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection'].includes(stage);

function lookupInformation(store,{lookupResults,subjectId,currentEvent,workspace,consultation=false}) {
  ensure(Array.isArray(lookupResults)&&lookupResults.length<=4,'INPUT_LIMIT','up to four explicit local lookup results');
  const refs=uniqueRefs(lookupResults);
  const records=refs.map(r=>record(store,r,['lookup_result']));
  if(records.length){
    ensure(subjectId!==null,'MISSING_SUBJECT','lookup results require a continuous subject');
    const subject=store.read(subjectId);
    ensure(records.every(r=>r.subject===subjectId),'SUBJECT_MISMATCH','only own lookup results may be admitted');
    ensure(records.every(r=>(currentEvent?sameRef(r.anchor,currentEvent):r.anchor===null)&&sameRef(r.workspace,workspace)),'LOOKUP_CONTEXT_MISMATCH','lookup results are historical to another current context; use explicit material references to recall them');
    ensure(records.some(r=>sameRef(r.decision,subject.lastDecision)),'SUPERSEDED_LOOKUP','a newer decision has replaced this lookup continuation');
  }
  const candidates=new Map();
  for(const r of records)for(const entry of r.entries){
    if(!['event','note'].includes(entry.type))continue; // entity/binding are directory handles, not material bodies
    const value=record(store,entry.ref,['event','note']);
    if(!candidates.has(refKey(entry.ref)))candidates.set(refKey(entry.ref),{ref:entry.ref,aspect:memoryAspect(value)});
  }
  const active=consultation?records.find(r=>sameRef(r.decision,store.read(subjectId)?.lastDecision)&&r.consultation):null;
  const desk=consultation?consultationDesk({read:(id,rev)=>store.read(id,rev),results:records,subjectId,currentEvent,workspace,lastDecision:store.read(subjectId)?.lastDecision,
    pages:active?store.consultationPages({subjectId,root:active.consultation.root,currentEvent,workspace}):[]}):null;
  const associations=records.length?retrievalAssociations({store,subjectId,currentEvent,results:records,limit:4}):null;
  return {desk,traces:records.filter(r=>r.trace),associations,candidates:[...candidates.values()],
    trace:{format:'retrieval-trace-v1',steps:records.map((r,i)=>({step:i+1,query:r.query,requested:r.requested,outcome:r.outcome,result:asRef(r)}))},
    results:records.map(r=>({ref:asRef(r),decision:r.decision,round:r.round,
    requested:r.requested,query:r.query,outcome:r.outcome,method:r.method,total:r.total,epoch:r.epoch,entries:r.entries,...(r.trace?{asOf:r.recordedAt}:{}),...(r.opened?{opened:r.opened}:{}),
    novelRefs:r.novelRefs,repeatOf:r.repeatOf,remainingReadsAtResult:r.remainingReads,
    nextPage:r.nextOffset===null?null:asRef(r),...(r.workbench?{workbench:r.workbench}:{}),...(r.graph?{graph:r.graph}:{}),...(r.states?{states:r.states}:{}),
    ...(r.consultation?{consultation:r.consultation}:{}),...(r.trace?{trace:{route:r.trace.route,epoch:r.trace.epoch,stop:r.trace.stop,limits:r.trace.limits,missing:r.trace.missing,
      excludedCount:r.trace.excluded.count,checkedEdges:r.trace.checkedEdges,nodeCount:r.trace.nodes.length,pathCount:r.trace.paths.length,
      catalog:'stored-locally-not-delivered-bodies',interpretation:r.trace.interpretation},novelNodes:r.novelNodes}:{}),...(r.failure?{failure:r.failure}:{})}))};
}

function deliverLookupMaterials({materials,candidates,currentEvent=null,render}){
  const assignments=[...materials];let packet=render(assignments);
  for(const candidate of candidates){
    if(sameRef(candidate.ref,currentEvent)||assignments.some(a=>sameRef(a.ref,candidate.ref))||assignments.length>=32)continue;
    try{const next=render([...assignments,candidate]);assignments.push(candidate);packet=next;}
    catch(error){if(error.code!=='INPUT_OVERFLOW')throw error;}
  }
  return packet;
}

export function prepareDecision(args){
  try{
    const packet=buildDecision(args),snapshot=args.store.captureDebugPacket(packet);
    args.store.recordDiagnostic({stage:'input.prepared',status:'ok',context:packetContext(packet),data:{schemaStage:packet.stage,bytes:packet.bytes,budgetBytes:packet.budgetBytes,snapshot}});
    return packet;
  }catch(error){
    if(error.code==='INPUT_OVERFLOW'&&args.workbenchMaterials){
      const frame=args.store.read(attentionId(args.subjectId));
      const required=frame?attentionView(frame,{read:(id,rev)=>args.store.read(id,rev),currentEvent:args.currentEvent,workbenchFocus:args.workbenchFocus===true}).metadata.materials?.filter(m=>m.delivery==='required').map(m=>m.ref)??[]:[];
      if(required.length){error.code='WORKBENCH_REQUIRED_OVERFLOW';error.details={...error.details,requiredMaterials:uniqueRefs(required),interpretation:'bindings-retained; no-partial-required-delivery'};}
    }
    args?.store?.recordDiagnostic({stage:'input.rejected',status:'rejected',context:{subjectId:args.subjectId,eventId:args.currentEvent?.id,workspaceId:args.workspace?.id},
      data:{...failureMetadata(error),...(error.code==='WORKBENCH_REQUIRED_OVERFLOW'?{requiredMaterials:error.details.requiredMaterials,bytes:error.details.requiredBytes,budgetBytes:args.budgetBytes}:{})}});throw error;}
}
function previousDecisionCards(store,refs,{subjectId,workspace,enhanced=false}){
  ensure(Array.isArray(refs)&&refs.length<=4,'INPUT_LIMIT','up to four previous decisions');
  return refs.map(r=>{const d=record(store,r,['decision']);
    if(enhanced)ensure(d.input.payload.continuity?.subject.id===subjectId&&d.workspace.id===workspace.id,'SUBJECT_MISMATCH','handoff needs own decision in this workspace');
    const priorReads=enhanced?[...(d.input.payload.information?.results??[]).map(r=>store.read(r.ref.id,r.ref.revision)),...[...store.all('lookup_result')].filter(r=>r.subject===subjectId&&sameRef(r.decision,asRef(d)))].filter(Boolean):[];
    const reads=[...new Map(priorReads.map(r=>[refKey(r),r])).values()];
    return {ref:asRef(d),selected:d.output.options.find(o=>o.id===d.output.selected),summary:d.output.summary,action:d.action,
      ...(enhanced?{origin:{workspace:d.workspace,currentEvent:d.currentEvent,reflection:d.reflection===true,task:d.input.payload.task?.id??null,controlRevision:d.input.payload.task?.controlRevision??null},apperception:d.output.apperception??null,used:d.output.used??[],
        readHistory:{items:reads.slice(-4).map(r=>({ref:asRef(r),query:r.query,outcome:r.outcome,materialRefs:r.entries.map(e=>e.ref),remainingReadsAtResult:r.remainingReads})),omitted:Math.max(0,reads.length-4),meaning:'historical-read-receipts-pointers-only-not-delivered-bodies-or-current-read-budget'},
        interpretation:'prior-public-decision-not-new-evidence-not-instructions-not-necessarily-relevant; explicit states and pinned sources remain authoritative'}:{})};
  });
}
function buildDecision({store,currentEvent,workspace,identity='',style='',materials=[],previousDecisions=[],investigationContinuityV1=false,experienceLearningV1=false,allowedActionTools=[],budgetBytes,subjectId=null,stateRefs=[],stateDetail=false,lookupResults=[],localLookupPolicy=null,mind=false,unified=false,waitSupport=false,consultation=false,consultationProgress=false,workbenchMaterials=false,workbenchFocus=false,workbenchRecovery=false,now=null,capabilities=null,algorithmV011=false,apperceptionV1=false,subjectiveDomains=false,subjectiveMemory=false,subjectiveMemoryV2=false,taskThreads=false,anchorDirectory=false,task=null,motivationProjection=null,internalSources=[],instructionSuffix=null}) {
  ensure(typeof investigationContinuityV1==='boolean','INVALID_INPUT','investigation continuity must be boolean');
  ensure(typeof experienceLearningV1==='boolean','INVALID_INPUT','experience learning must be boolean');
  ensure(typeof workbenchRecovery==='boolean'&&(!workbenchRecovery||workbenchFocus&&workbenchMaterials&&localLookupPolicy!==null),'RECOVERY_CAPABILITY','recovery requires focus, materials and a local read budget');
  return store.view(()=>{
    ensure(typeof mind==='boolean'&&(!mind||subjectId!==null),'MIND_PROTOCOL_REQUIRED','mind mode needs an explicit continuous subject');
    ensure(typeof unified==='boolean'&&(!unified||mind&&localLookupPolicy!==null),'UNIFIED_PROTOCOL_REQUIRED','unified mode requires mind, attention and an explicit read policy');
    ensure(typeof consultation==='boolean'&&(!consultation||unified),'CONSULT_CAPABILITY','consultation requires explicit unified mode');
    ensure(typeof consultationProgress==='boolean'&&(!consultationProgress||consultation),'CONSULT_CAPABILITY','progress requires explicit consultation mode');
    ensure(typeof workbenchFocus==='boolean'&&(!workbenchFocus||workbenchMaterials),'FOCUS_CAPABILITY','focus requires explicit material capability');
    ensure(typeof workbenchMaterials==='boolean'&&(!workbenchMaterials||subjectId!==null&&store.read(attentionId(subjectId))),
      'WORKBENCH_CAPABILITY','material residency requires explicit attention and subject');
    ensure(typeof identity==='string'&&[...identity].length<=4000,'INPUT_LIMIT','bounded host-supplied identity required');
    const current=record(store,currentEvent,['event']), w=record(store,workspace,['workspace']);
    ensure(['observed','reported','tool_receipt'].includes(current.origin),'NOT_AN_ENCOUNTER','decision trigger must be an actual received observation');
    ensure(store.read(w.id).revision===w.revision,'STALE_WORKSPACE','fresh workspace required');
    ensure(Array.isArray(previousDecisions)&&previousDecisions.length<=4,'INPUT_LIMIT','up to four previous decisions');
    const prior=previousDecisionCards(store,previousDecisions,{subjectId,workspace:w,enhanced:investigationContinuityV1});
    const information=lookupInformation(store,{lookupResults,subjectId,currentEvent,workspace,consultation});
    ensure(task===null||typeof task==='object'&&!Array.isArray(task),'TASK_CONTEXT','task must be an object or null');
    const payload={format:'jingyang-decision-input-v1',identity,...(style?{style:{format:'style-pack-v1',text:String(style).slice(0,16000)}}:{}),current,workspace:w,materials:materialList(store,materials,consultation),previousDecisions:prior,allowedActionTools:permitted(allowedActionTools),...(now!==null?{now}:{}),...(algorithmV011?{algorithmV011:{format:'algorithm-v011-v1',enabled:true}}:{}),...(apperceptionV1?{apperceptionV1:{format:'apperception-v1',enabled:true}}:{}),...(subjectiveDomains?{subjectiveDomains:{format:'subjective-domains-v1',enabled:true}}:{}),...(subjectiveMemory?{subjectiveMemory:{format:'subjective-memory-v1',enabled:true}}:{}),...(subjectiveMemoryV2?{subjectiveMemoryV2:{format:'subjective-memory-v2',enabled:true}}:{}),...(taskThreads?{taskThreads:{format:'task-threads-v1',enabled:true}}:{}),...(anchorDirectory?{anchorDirectory:{format:'anchor-directory-v1',enabled:true}}:{}),...(task!==null?{task}:{})};
    // Apply only when preparing a new opportunity. seal()/verify() must keep
    // previously captured, unpaged packets byte-for-byte recoverable.
    pageCurrentReceipt(payload);
    ensure(typeof waitSupport==='boolean'&&(!waitSupport||subjectId!==null),'WAIT_CAPABILITY','explicit wait support requires a continuous subject');
    if(waitSupport)payload.waitSupport=waitSupportInput({store,subjectId});
    if(localLookupPolicy!==null){
      ensure(subjectId!==null,'MISSING_SUBJECT','local memory capability requires a continuous subject');
      const policy=lookupPolicy(localLookupPolicy),round=store.read(lookupRoundId(subjectId,currentEvent));
      ensure(!round||round.type==='lookup_round'&&canonical(round.policy)===canonical(policy),'LOOKUP_POLICY','declared lookup policy differs from persistent round');
      payload.memoryAccess={available:true,routes:['terms','ref','pageAfter','context','person','recall','entity','open'],method:'exact-substring-or-pinned-version',
        contextRoute:{shape:{context:{anchor:{id:'explicit-event-id',revision:1},terms:['keyword']}},
          meaning:'prioritize explicit action-input/receipt and evidence lineage for this pinned event; other matches remain pageable; association is not proof of applicability'},
        scope:'own-retained-events-and-notes',maxResultsPerRead:policy.maxHits,remainingReads:policy.maxReads-(round?.reads??0),
        loadedMaterialsAreNotEntireArchive:true};
      if(consultation){payload.memoryAccess.routes.push('consult');payload.memoryAccess.consultation={enabled:true,
        vias:['find','read','grounds','impact','progress','related','versions','back','forward','directory','history'],discovery:'catalog-only; read-full-version-before-citing',
        continuation:'need is a short initial description or a prior consultation result ref',sharedReadBudget:true,
        navigationRemaining:Math.max(0,32-(round?.navigationSteps??0)),navigationMeaning:'cached-page-visit; model-calls-still-cost; no-undo-of-events-or-state'};}
    }
    if(subjectId!==null){
      ensure(store.subjectObservation(subjectId,current.id),'OBSERVATION_NOT_ADMITTED','admit this observation before deciding');
      const resultStates=information.results.flatMap(r=>r.states??[]).map(x=>x.ref);
      payload.format='jingyang-decision-continuity-v1';payload.continuity=continuityInput({store,subjectId,motivationProjection,internalSources,stateRefs:uniqueRefs([...stateRefs,...resultStates]),detail:stateDetail,evidenceDetail:investigationContinuityV1,currentEvent,mind,workbenchFocus,subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory,
        focusProcessIds:information.results.flatMap(r=>r.graph?.nodes??[]).map(p=>p.id)});
      if(experienceLearningV1)payload.experienceLearning=experienceLearningInput({store,subjectId});
      if(capabilities!==null)payload.continuity.capabilities={format:'capability-map-v1',contractVersion:2,enabled:[...new Set(capabilities)]};
      const attention=Boolean(payload.continuity.attention);
      const retained=payload.continuity.attention?.materials??[];
      ensure(workbenchMaterials||retained.length===0,'WORKBENCH_CAPABILITY','retained material bindings require explicit workbenchMaterials; cannot silently bypass them');
      if(workbenchMaterials){
        payload.continuity.attention.materialSupport={enabled:true,format:'purpose-material-v1',meaning:'pinned-history-not-current-observation; binding-not-adoption; required-bodies-delivered-together'};
        if(workbenchRecovery){payload.continuity.attention.recoverySupport={enabled:true,format:'material-use-history-v1',frame:payload.continuity.attention.frame};payload.memoryAccess.routes.push('workbench');}
        const combined=new Map(materials.map(m=>[canonical([m.ref,m.aspect]),m]));
        for(const entry of retained.filter(m=>m.delivery==='required')){
          const assignment={ref:entry.ref,aspect:memoryAspect(record(store,entry.ref,['event','note']))};combined.set(canonical([assignment.ref,assignment.aspect]),assignment);
        }
        materials=[...combined.values()];payload.materials=materialList(store,materials,true);
      }
      ensure(!mind||attention,'MIND_PROTOCOL_REQUIRED','mind mode requires explicit purpose-based attention');
      const stage=unified?'decisionGraph':mind?'decisionMind':attention?'decisionAttention':localLookupPolicy!==null?'decisionWorkbench':'decisionInformation';
      if(attention&&payload.memoryAccess){payload.memoryAccess.routes.push('graph','stateRef');payload.memoryAccess.scope='own-retained-events-notes-states-and-processes';}
      if(unified){payload.memoryAccess.routes.push('trace');payload.memoryAccess.scope='own-retained-content-and-explicit-operational-context';}
      ensure(!information.traces.length||unified,'UNIFIED_PROTOCOL_REQUIRED','cross-type results require unified mode to deliver complete packages');
      if(!information.results.length){if(unified)payload.format='jingyang-decision-graph-v1';else if(mind)payload.format='jingyang-decision-mind-v1';else if(attention)payload.format='jingyang-decision-attention-v1';else if(localLookupPolicy!==null)payload.format='jingyang-decision-workbench-v1';return seal(attention||localLookupPolicy!==null?stage:'decisionContinuity',payload,budgetBytes,instructionSuffix);}
      payload.format=unified?'jingyang-decision-graph-v1':mind?'jingyang-decision-mind-v1':attention?'jingyang-decision-attention-v1':localLookupPolicy!==null?'jingyang-decision-workbench-v1':'jingyang-decision-local-lookup-v1';
      const render=assignments=>{
        const delivered=materialList(store,assignments,consultation),keys=new Set([refKey(current),...delivered.map(m=>refKey(m.ref))]);
        const presented=information.candidates.filter(c=>keys.has(refKey(c.ref))).map(c=>c.ref);
        const omitted=information.candidates.filter(c=>!keys.has(refKey(c.ref))).map(c=>({ref:c.ref,reason:'input-budget-or-material-limit'}));
        const data={...payload,materials:delivered,information:{kind:'local-memory-results',originalTrigger:currentEvent,
          ...(information.trace?{trace:information.trace}:{}),
          ...(information.associations?{associations:information.associations}:{}),
          results:information.results,...(information.desk?{consultationDesk:information.desk}:{}),presentation:{presented,omitted}}};
        if(consultationProgress)data.information.progress=progressProjection({read:(id,rev)=>store.read(id,rev),lastDecision:store.read(subjectId).lastDecision,
          subjectId,currentEvent,workspace,payload:data});
        return seal(stage,data,budgetBytes,instructionSuffix);
      };
      const packet=deliverLookupMaterials({materials,candidates:information.candidates,currentEvent,render});
      if(!information.traces.length)return packet;
      return deliverTracePackages({packet,information,store,subjectId,motivationProjection,internalSources,stateRefs,resultStates,stateDetail,currentEvent,mind,workbenchFocus,subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory,workbenchMaterials,workbenchRecovery,consultation,consultationProgress,stage,budgetBytes,instructionSuffix,investigationContinuityV1});
    }
    ensure(stateRefs.length===0&&!stateDetail,'MISSING_SUBJECT','state reads require an explicit subject');
    return seal('decision',payload,budgetBytes,instructionSuffix);
  });
}

function deliverTracePackages({packet,information,store,subjectId,motivationProjection,internalSources,stateRefs,resultStates,stateDetail,currentEvent,mind,workbenchFocus,subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory,workbenchMaterials,workbenchRecovery,consultation,consultationProgress=false,stage,budgetBytes,instructionSuffix,investigationContinuityV1=false}){
      const base=packet.payload,loaded=new Map(),load=n=>{
        const key=nodeKey(n.ref);if(!loaded.has(key))loaded.set(key,store.readGraphNode({subjectId,ref:n.ref}));
        const value=loaded.get(key);ensure(value,'TRACE_REF','a pinned graph source is no longer available');return value;
      };
      const baseRecords=information.traces.flatMap(r=>r.trace.nodes).filter(n=>graphRecordPresent(base,n.ref)).map(n=>n.ref);
      return assembleGraphPackages({baseRecords,traces:information.traces,render:(selected,presentation)=>{
        const full=selected.map(load),stateNodes=full.filter(x=>x.descriptor.type==='personal_state');
        const continuity=continuityInput({store,subjectId,motivationProjection,internalSources,stateRefs:uniqueRefs([...stateRefs,...resultStates,...stateNodes.map(x=>asRef(x.record))]),detail:stateDetail,evidenceDetail:investigationContinuityV1,currentEvent,mind,workbenchFocus,subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory,
          focusProcessIds:full.filter(x=>x.descriptor.type==='process').map(x=>x.record.id)});
        if(base.continuity.contactTargets)continuity.contactTargets=base.continuity.contactTargets;
        if(base.continuity.capabilities)continuity.capabilities=base.continuity.capabilities;
        const stateKeys=new Set(stateNodes.map(x=>nodeKey(x.descriptor.ref)));
        for(const group of ['foreground','recalled'])continuity[group]=continuity[group].map(card=>stateKeys.has(nodeKey(recordNode(card.ref)))?
          stateCard(store.read(card.ref.id,card.ref.revision),{historical:card.historical,detail:true}):card);
        const extras=full.filter(x=>['event','note'].includes(x.descriptor.type)).map(x=>({ref:asRef(x.record),aspect:memoryAspect(x.record)}));
        const delivered=materialList(store,[...base.materials.flatMap(m=>m.aspects.map(aspect=>({ref:m.ref,aspect}))),...extras],consultation||stage==='reflection');
        const cards=full.filter(x=>!['event','note','personal_state'].includes(x.descriptor.type)).map(x=>({ref:x.descriptor.ref,
          type:x.descriptor.type,historical:x.descriptor.historical,latestOwner:x.descriptor.latestOwner,representation:x.representation,
          record:x.record,interpretation:'retained-process-or-operation-context-not-new-observation'}));
        const deliveredKeys=new Set([...baseRecords,...selected.map(n=>n.ref)].map(nodeKey));
        const paths=[...new Map(information.traces.flatMap(r=>r.trace.paths).filter(e=>deliveredKeys.has(nodeKey(e.from))&&deliveredKeys.has(nodeKey(e.to)))
          .map(e=>[`${e.key}:${e.direction}`,{...e,historicalAtDelivery:store.read(e.owner.id)?.revision!==e.owner.revision,
            interpretation:'recorded-relation-at-query-not-new-evidence'}])).values()];
        if(workbenchMaterials)continuity.attention.materialSupport=base.continuity.attention.materialSupport;
        if(workbenchRecovery)continuity.attention.recoverySupport=base.continuity.attention.recoverySupport;
        const data={...base,continuity,materials:delivered,knowledge:{format:'jingyang-graph-packages-v1',cards,paths,presentation}};
        if(consultationProgress)data.information={...data.information,progress:progressProjection({read:(id,rev)=>store.read(id,rev),lastDecision:store.read(subjectId).lastDecision,
          subjectId,currentEvent,workspace,payload:data})};
        return seal(stage,data,budgetBytes,instructionSuffix);
      }});
}

// 反射轮：没有世界观察，只给内部时间/注意力摘要；决定仍由她做。
export function prepareReflection({previousDecisions=[],investigationContinuityV1=false,experienceLearningV1=false,store,subjectId,workspace,identity='',style='',internal,budgetBytes,materials=[],stateRefs=[],stateDetail=false,allowedActionTools=[],lookupResults=[],localLookupPolicy=null,capabilities=null,memoryUpdateDue=false,followup=null,apperceptionV1=false,motivationProjection=null,internalSources=[],instructionSuffix=null,subjectiveDomains=false,subjectiveMemory=false,subjectiveMemoryV2=false,taskThreads=false,anchorDirectory=false}){
  ensure(typeof investigationContinuityV1==='boolean','INVALID_INPUT','investigation continuity must be boolean');
  ensure(typeof experienceLearningV1==='boolean','INVALID_INPUT','experience learning must be boolean');
  text(subjectId,'subject id');
  ensure(typeof identity==='string'&&[...identity].length<=4000,'INPUT_LIMIT','bounded host-supplied identity required');
  ensure(internal?.format==='reflection-frame-v1','REFLECTION_INPUT','reflection frame required');
  return store.view(()=>{
    const w=store.read(workspace?.id??workspace,workspace?.revision);
    ensure(w?.type==='workspace','MISSING_WORKSPACE','existing workspace required');
    ensure(store.read(w.id).revision===w.revision,'STALE_WORKSPACE','fresh workspace required');
    const information=lookupInformation(store,{lookupResults,subjectId,currentEvent:null,workspace:asRef(w),consultation:false});
    ensure(!information.traces.length||investigationContinuityV1,'UNIFIED_PROTOCOL_REQUIRED','cross-type results require explicit history recovery');
    const resultStates=information.results.flatMap(r=>r.states??[]).map(x=>x.ref);
    const continuity=continuityInput({store,subjectId,motivationProjection,internalSources,stateRefs:uniqueRefs([...stateRefs,...resultStates]),detail:stateDetail,evidenceDetail:investigationContinuityV1,currentEvent:null,mind:true,workbenchFocus:true,
      focusProcessIds:information.results.flatMap(r=>r.graph?.nodes??[]).map(p=>p.id),subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory});
    continuity.contactTargets=[...new Set([
      ...[...store.all('workspace')].map(x=>x.scene),
      ...[...store.all('event')].map(x=>x.scene)
    ].filter(x=>typeof x==='string'&&/^qq\/(private|group)\//.test(x)))].sort().map(scene=>({scene}));
    if(capabilities!==null)continuity.capabilities={format:'capability-map-v1',contractVersion:2,enabled:[...new Set(capabilities)]};
    // A reflection keeps the same purpose-bound workbench. Required materials are not optional search hits.
    const retained=continuity.attention?.materials??[];
    if(continuity.attention)continuity.attention.materialSupport={enabled:true,format:'purpose-material-v1',meaning:'pinned-history-not-current-observation; binding-not-adoption; required-bodies-delivered-together'};
    const combined=new Map(materials.map(m=>[canonical([m.ref,m.aspect]),m]));
    for(const entry of retained.filter(m=>m.delivery==='required')){
      const assignment={ref:entry.ref,aspect:memoryAspect(record(store,entry.ref,['event','note']))};combined.set(canonical([assignment.ref,assignment.aspect]),assignment);
    }
    const assignments=[...combined.values()];
    const payload={format:'jingyang-reflection-input-v1',...(apperceptionV1?{apperceptionV1:{format:'apperception-v1',enabled:true}}:{}),
      ...(subjectiveDomains?{subjectiveDomains:{format:'subjective-domains-v1',enabled:true}}:{}),
      ...(subjectiveMemory?{subjectiveMemory:{format:'subjective-memory-v1',enabled:true}}:{}),
      ...(subjectiveMemoryV2?{subjectiveMemoryV2:{format:'subjective-memory-v2',enabled:true}}:{}),
      ...(taskThreads?{taskThreads:{format:'task-threads-v1',enabled:true}}:{}),
      ...(anchorDirectory?{anchorDirectory:{format:'anchor-directory-v1',enabled:true}}:{}),
      ...(investigationContinuityV1?{previousDecisions:previousDecisionCards(store,previousDecisions,{subjectId,workspace:w,enhanced:true})}:{}),identity,...(style?{style:{format:'style-pack-v1',text:String(style).slice(0,16000)}}:{}),workspace:w,internal,materials:materialList(store,assignments,true),allowedActionTools:permitted(allowedActionTools),continuity,
      ...(experienceLearningV1?{experienceLearning:experienceLearningInput({store,subjectId})}:{}),
      ...(memoryUpdateDue?{memoryUpdate:{format:'memory-update-opportunity-v1',due:true}}:{}),...(followup?{followup}:{})};
    if(localLookupPolicy!==null){
      const policy=lookupPolicy(localLookupPolicy);
      // Continue the originating opportunity, not a new budget for each lookup/model call.
      const scopes=information.results.map(r=>record(store,r.decision,['decision']).input.payload.memoryAccess?.roundScope??null);
      const roundScope=scopes.length?scopes[0]:digest({subject:continuity.subject,workspace:asRef(w),internal});
      ensure(scopes.every(x=>x===roundScope),'LOOKUP_CONTEXT_MISMATCH','reflection results belong to different opportunities');
      const roundId=lookupRoundId(subjectId,null,roundScope),round=store.read(roundId);
      ensure(information.results.every(x=>x.round.id===roundId),'LOOKUP_CONTEXT_MISMATCH','reflection read scope changed');
      ensure(!round||round.type==='lookup_round'&&canonical(round.policy)===canonical(policy),'LOOKUP_POLICY','declared lookup policy differs from persistent round');
      payload.memoryAccess={available:true,roundScope,routes:['terms','ref','pageAfter','context','person','recall','entity','open',...(continuity.attention?['graph','stateRef']:[])],
        method:'exact-substring-or-pinned-version',scope:'own-retained-history-not-new-observation',maxResultsPerRead:policy.maxHits,
        remainingReads:policy.maxReads-(round?.reads??0),loadedMaterialsAreNotEntireArchive:true};
    }
    if(investigationContinuityV1){
      ensure(localLookupPolicy!==null,'RECOVERY_CAPABILITY','history recovery requires an explicit read budget');
      payload.memoryAccess.historyRecovery={enabled:true,meaning:'own pinned historical sources; not a new observation'};
      payload.memoryAccess.routes.push('workbench','trace');
      continuity.attention.recoverySupport={enabled:true,format:'material-use-history-v1',frame:continuity.attention.frame};
    }
    const render=selected=>{
      const delivered=materialList(store,selected,true),keys=new Set(delivered.map(m=>refKey(m.ref)));
      const presentation={presented:information.candidates.filter(c=>keys.has(refKey(c.ref))).map(c=>c.ref),
        omitted:information.candidates.filter(c=>!keys.has(refKey(c.ref))).map(c=>({ref:c.ref,reason:'input-budget-or-material-limit'}))};
      return seal('reflection',{...payload,materials:delivered,...(information.results.length?{information:{kind:'local-memory-results',originalTrigger:null,trace:information.trace,
        ...(information.associations?{associations:information.associations}:{}),results:information.results,presentation}}:{})},budgetBytes,instructionSuffix);
    };
    try{const packet=deliverLookupMaterials({materials:assignments,candidates:information.candidates,render});
      if(!information.traces.length)return packet;
      return deliverTracePackages({packet,information,store,subjectId,motivationProjection,internalSources,stateRefs,resultStates,stateDetail,currentEvent:null,mind:true,workbenchFocus:true,subjectiveDomains,subjectiveMemory,subjectiveMemoryV2,taskThreads,anchorDirectory,workbenchMaterials:true,workbenchRecovery:true,consultation:false,stage:'reflection',budgetBytes,instructionSuffix,investigationContinuityV1});}
    catch(error){
      if(error.code==='INPUT_OVERFLOW'&&retained.some(m=>m.delivery==='required')){error.code='WORKBENCH_REQUIRED_OVERFLOW';error.details={...error.details,requiredMaterials:uniqueRefs(retained.filter(m=>m.delivery==='required').map(m=>m.ref)),interpretation:'bindings-retained; no-partial-required-delivery'};}
      throw error;
    }
  });
}

const APPERCEPTION_DOMAINS=new Set(['self','relationship','world','normative']);
const APPERCEPTION_PERSPECTIVES=new Set(['relevance','meaning','coping','norm_self']);
const APPERCEPTION_STATUSES=new Set(['fact','interpretation','inference','uncertain']);
export function apperceptionSources(packet){
  const allowed=new Set();
  const add=r=>{if(r&&typeof r.id==='string'&&Number.isSafeInteger(r.revision))allowed.add(`${r.id}@${r.revision}`);};
  add(packet.payload.current);
  for(const m of packet.payload.materials??[])add(m.ref);
  for(const item of packet.payload.continuity?.recent?.items??[])add(item.ref);
  for(const item of packet.payload.continuity?.shortTerm?.items??[])add(item.ref);
  for(const item of packet.payload.continuity?.subjectiveMemory?.recent?.items??[])add(item.ref);
  for(const item of packet.payload.continuity?.subjectiveMemory?.compressed?.items??[])add(item.ref);
  for(const item of packet.payload.continuity?.subjectiveMemory?.maintenance?.olderRecent??[])add(item.ref);
  for(const x of [...(packet.payload.continuity?.foreground??[]),...(packet.payload.continuity?.recalled??[])])add(x.ref);
  for(const source of packet.payload.continuity?.internalSources??[])add(source.ref);
  return allowed;
}
export function normalizeApperception(value,packet){
  exact(value,['schema_version','activated_cells','integrated_understanding'],'apperception');
  ensure(value.schema_version==='apperception.slice.v1','APPERCEPTION_SHAPE','wrong apperception schema');
  ensure(Array.isArray(value.activated_cells)&&value.activated_cells.length<=16,'APPERCEPTION_LIMIT','up to sixteen cells');
  short(value.integrated_understanding,'integrated understanding',1200);
  const allowed=apperceptionSources(packet);
  const cells=value.activated_cells.map((cell,index)=>{
    exact(cell,['domain','perspective','content','epistemic_status','source_refs','uncertainty'],`apperception cell ${index}`);
    ensure(APPERCEPTION_DOMAINS.has(cell.domain),'APPERCEPTION_SHAPE','invalid domain');
    ensure(APPERCEPTION_PERSPECTIVES.has(cell.perspective),'APPERCEPTION_SHAPE','invalid perspective');
    ensure(APPERCEPTION_STATUSES.has(cell.epistemic_status),'APPERCEPTION_SHAPE','invalid epistemic status');
    short(cell.content,'cell content',600);
    ensure(Array.isArray(cell.source_refs)&&cell.source_refs.length<=8,'APPERCEPTION_LIMIT','bounded source refs');
    const refs=uniqueRefs(cell.source_refs);
    for(const r of refs)ensure(allowed.has(`${r.id}@${r.revision}`),'UNDELIVERED_REFERENCE','apperception source was not delivered');
    if(cell.uncertainty!==null)short(cell.uncertainty,'cell uncertainty',300);
    return {domain:cell.domain,perspective:cell.perspective,content:cell.content,epistemic_status:cell.epistemic_status,source_refs:refs,uncertainty:cell.uncertainty};
  });
  return {schema_version:'apperception.slice.v1',activated_cells:cells,integrated_understanding:value.integrated_understanding};
}
export function commitDecision(args){  const context=packetContext(args?.packet,{decisionId:args?.decisionId,requestId:args?.requestId});
  try{
    const result=commitDecisionChecked(args),choice=result.output.options.find(o=>o.id===result.output.selected);
    args.store.recordDiagnostic({stage:'decision.accepted',status:'ok',context,data:{selectedKind:choice.kind,changeCount:result.output.continuity?.changes.length??0}});
    return result;
  }catch(error){args?.store?.recordDiagnostic({stage:'decision.rejected',status:'rejected',context,data:{...failureMetadata(error),...outputMetrics(args?.output)}});throw error;}
}
function commitDecisionChecked({store,packet,output,requestId,decisionId,allowedActionTools=[],maxOutputBytes=16384,invocationKey=null,guardRefs=[],taskGuard=null,motivationTransition=null,affectTurn=null,extensionWrites=[]}) {
  const reflection=packet?.stage==='reflection';
  const hasContinuity=continuityStage(packet?.stage);verify(packet,hasContinuity?packet.stage:'decision');text(requestId,'request id');text(decisionId,'decision id');
  ensure(!reflection||packet.payload.current===undefined,'REFLECTION_INPUT','reflection packet has no world observation');
  ensure(invocationKey===null||typeof invocationKey==='string'&&/^[a-f0-9]{64}$/.test(invocationKey),'INVALID_INPUT','invocation key must be null or a SHA256 digest');
  const out=parse(output,maxOutputBytes);
  if(Object.hasOwn(out,'apperception')){
    try{
      if(packet.payload.apperceptionV1?.enabled!==true)throw Object.assign(new Error('apperception capability was not enabled'),{code:'APPERCEPTION_DISABLED'});
      out.apperception=normalizeApperception(out.apperception,packet);
    }catch(error){
      delete out.apperception;
      store.recordDiagnostic({stage:'apperception.invalid',status:'fallback',context:packetContext(packet,{decisionId,requestId}),data:{...failureMetadata(error),interpretation:'decision continues without projection'}});
    }
  }
  // Task-step models sometimes echo the input attention frame into the output delta.
  // Only an exact echo is removed; any other frame or shape remains invalid.
  if(out?.continuity?.attention&&Object.hasOwn(out.continuity.attention,'frame')){
    const inputFrame=packet.payload?.continuity?.attention?.frame;
    if(inputFrame&&canonical(out.continuity.attention.frame)===canonical(inputFrame))delete out.continuity.attention.frame;
  }
  if(out?.continuity?.attention?.focus?.keep===true&&Array.isArray(out.continuity.attention.focus.select))delete out.continuity.attention.focus.keep;
    exact(out,['packetId','options','selected','summary','used',...(hasContinuity?['continuity']:[]),...(Object.hasOwn(out,'apperception')?['apperception']:[]),...(Object.hasOwn(out,'lessons')?['lessons']:[])],'decision');
  ensure(out.packetId===packet.packetId,'WRONG_PACKET','output belongs to another input');
  ensure(Array.isArray(out.options)&&out.options.length>0&&out.options.length<=8,'OUTPUT_LIMIT','1..8 options required');
  out.options=out.options.map(option=>normalizeVerbOption(option,{store,subjectId:packet.payload.continuity?.subject?.id??null,now:packet.payload.now??Date.now(),currentScene:packet.payload.workspace?.scene??null}));
  // Preserve bounded, correctly bound final proposals before per-field validation.
  // A malformed reference remains unadopted, never becomes memory, and must not trigger another paid call on re-entry.
  const attempt=hasContinuity?store.execute({requestId:`capture:${requestId}`,commands:[{op:'capture_decision_attempt',id:`${decisionId}:attempt`,decisionId,input:packet,output:out,requestKey:requestId,invocationKey}]}).at(-1):null;
  try{
  if(hasContinuity)normalizeStateDelta(out.continuity,{attention:['decisionAttention','decisionMind','decisionGraph','reflection'].includes(packet.stage),reflection});
  short(out.summary,'summary');
  const ids=new Set();
  for(const o of out.options) {
    exact(o,['id','kind','payload'],'option');text(o.id,'option id');ensure(!ids.has(o.id),'DUPLICATE_OPTION','unique option ids');ids.add(o.id);
    ensure(KINDS.includes(o.kind)&&o.payload&&Object.getPrototypeOf(o.payload)===Object.prototype,'OUTPUT_SHAPE','invalid option');
    if(o.kind==='none')exact(o.payload,[],'no-action payload');
    if(o.kind==='act'){exact(o.payload,['tool','args'],'action payload');text(o.payload.tool,'tool');ensure(o.payload.args&&Object.getPrototypeOf(o.payload.args)===Object.prototype,'OUTPUT_SHAPE','action args must be an object');}
    if(o.kind==='respond'){
      ensure(o.payload&&Object.getPrototypeOf(o.payload)===Object.prototype&&Object.keys(o.payload).every(k=>['text','target'].includes(k)),'OUTPUT_SHAPE','response payload fields do not match protocol');
      short(o.payload.text,'message',4000);
      if(reflection){
        if(packet.payload.followup)ensure(o.payload.target===packet.payload.followup.targetScene,'UNDELIVERED_TARGET','followup response must use its committed target');
        if(o.payload.target!==undefined&&o.payload.target!==null){
          text(o.payload.target,'response target');
          ensure(packet.payload.continuity.contactTargets.some(t=>t.scene===o.payload.target),'UNDELIVERED_TARGET','response target must be an explicitly delivered contact scene');
        }
      }else ensure(!Object.hasOwn(o.payload,'target'),'OUTPUT_SHAPE','respond target is only valid in reflection');
    }
    if(o.kind==='intent'){ensure(Object.getPrototypeOf(o.payload)===Object.prototype&&Object.keys(o.payload).every(k=>['goal','rationale','nextAction','dueAt','intentId','status'].includes(k)),'OUTPUT_SHAPE','intent payload fields do not match protocol');if(o.payload.intentId!==undefined)text(o.payload.intentId,'intent id');if(o.payload.goal!==undefined)text(o.payload.goal,'intent goal');if(o.payload.goal!==undefined)ensure([...o.payload.goal].length<=600,'OUTPUT_LIMIT','intent goal too long');if(o.payload.status!==undefined)ensure(['open','pursuing','deferred','completed','abandoned','expired'].includes(o.payload.status),'OUTPUT_SHAPE','intent status');if(o.payload.rationale!==undefined)short(o.payload.rationale,'intent rationale',600);if(o.payload.nextAction!==undefined)short(o.payload.nextAction,'intent next action',600);if(o.payload.dueAt!==undefined)ensure(Number.isSafeInteger(o.payload.dueAt),'OUTPUT_SHAPE','intent dueAt must be integer');}
    if(o.kind==='lookup'){
      normalizeLookupQuery(o.payload);
      ensure(!o.payload.consult||packet.payload.memoryAccess?.consultation?.enabled===true,'CONSULT_CAPABILITY','consultation was not granted in this input');
      ensure(!o.payload.graph&&!o.payload.stateRef||['decisionAttention','decisionMind','decisionGraph','reflection'].includes(packet.stage),'ATTENTION_REQUIRED','extended reads require attention mode');
      ensure(!o.payload.trace||packet.stage==='decisionGraph'||packet.stage==='reflection'&&packet.payload.memoryAccess?.historyRecovery?.enabled===true,'UNIFIED_PROTOCOL_REQUIRED','cross-type reads require explicit unified mode');
      ensure(!o.payload.workbench||packet.payload.continuity?.attention?.recoverySupport?.enabled===true,'RECOVERY_CAPABILITY','history route was not granted');
      if(o.payload.workbench){const r=o.payload.workbench.frame??o.payload.workbench.source.frame,f=packet.payload.continuity.attention.frame;
        ensure(r.id===f.id&&r.revision<=f.revision,'RECOVERY_SCOPE','history must be an own delivered-or-older frame');}
    }
  }
  const selected=out.options.find(o=>o.id===out.selected);ensure(selected,'INVALID_CHOICE','selected option is missing');
  const waitGuards=selected.kind==='wait'&&packet.payload.waitSupport?validateWaitCommit({store,support:packet.payload.waitSupport,payload:selected.payload}):[];
  ensure(Array.isArray(out.used)&&out.used.length<=16,'OUTPUT_LIMIT','up to sixteen used references');
  const delivered=new Map(packet.payload.materials.map(m=>[refKey(m.ref),m])), uses=new Set();
  for(const u of out.used){exact(u,['ref','aspect','effect'],'used');uniqueRefs([u.ref]);
    ensure(delivered.get(refKey(u.ref))?.aspects.includes(u.aspect),'UNDELIVERED_REFERENCE','used material or aspect was not in this input');
    ensure(['support','oppose','context','uncertain'].includes(u.effect),'OUTPUT_SHAPE','invalid use effect');
    const key=canonical([u.ref,u.aspect]);ensure(!uses.has(key),'DUPLICATE_USE','one use declaration per reference/aspect');uses.add(key);
  }
  ensure(Array.isArray(guardRefs)&&guardRefs.length<=16,'INPUT_LIMIT','up to sixteen explicit host commit guards');
  const commands=uniqueRefs([...guardRefs,...waitGuards]).map(ref=>({op:'assert_current',ref})), workspace=asRef(packet.payload.workspace), encounter=reflection?null:asRef(packet.payload.current);
  let action=null;
  if(taskGuard)commands.push({...taskGuard,op:'assert_task_control'});
  const lessonCommands=stageExperienceLessons({store,packet,output:out,decisionId});
  if(selected.kind==='intent'){
    const existing=selected.payload.intentId?store.read(selected.payload.intentId):null;
    if(selected.payload.intentId!==undefined)ensure(existing,'UNRESOLVED_INTENT','referenced intent does not exist; do not silently create a replacement');
    if(existing){ensure(existing.type==='intent'&&existing.subject===packet.payload.continuity.subject.id,'INTENT','own intent required');
      const delivered=packet.payload.continuity.intents?.find(i=>i.id===existing.id);
      ensure(delivered&&Number.isSafeInteger(delivered.revision),'UNDELIVERED_INTENT','read the intent before changing it');
      ensure(delivered.revision===existing.revision,'STALE_INTENT','intent changed since delivery');
      commands.push({op:'assert_current',ref:asRef(existing)});
      const intent={...existing,...Object.fromEntries(Object.entries(selected.payload).filter(([k])=>k!=='intentId').map(([k,v])=>[k,v==null?existing[k]:v])),updatedAt:packet.payload.now??Date.now()};
      commands.push({op:'put_intent',id:intent.id,expectedRevision:existing.revision,value:intent});
    }else{
      ensure(selected.payload.goal,'INTENT','new intent needs a goal');
      const intent={format:'jingyang-intent-v1',id:`intent:${packet.payload.continuity.subject.id}:${decisionId}`,subject:packet.payload.continuity.subject.id,goal:selected.payload.goal,
        rationale:selected.payload.rationale??null,nextAction:selected.payload.nextAction??null,dueAt:selected.payload.dueAt??null,status:selected.payload.status??'open',source:'reflection',createdAt:packet.payload.now??Date.now()};
      commands.push({op:'put_intent',id:intent.id,expectedRevision:0,value:intent});
    }
  }
  if(selected.kind==='act'){
    const tool=selected.payload.tool;
    ensure(packet.payload.allowedActionTools.includes(tool)&&permitted(allowedActionTools).includes(tool),'TOOL_NOT_GRANTED','tool not granted at preparation or commit');
    const taskIntentRefs=[];
    if(tool==='start_agent_task'&&selected.payload.args.intentId!==undefined){
      const id=selected.payload.args.intentId,delivered=packet.payload.continuity.intents?.find(i=>i.id===id),current=store.read(id);
      ensure(delivered&&current?.type==='intent'&&current.subject===packet.payload.continuity.subject.id,'UNDELIVERED_INTENT','task must reference a delivered own intent');
      ensure(delivered.revision===current.revision,'STALE_INTENT','task intent changed since delivery');taskIntentRefs.push(asRef(current));commands.push({op:'assert_current',ref:asRef(current)});
    }
    action={id:`${decisionId}:action`,revision:1};
    // The actual trigger is host execution context, not a fabricated model-use declaration.
    commands.push({op:'propose_action',id:action.id,workspace,tool,args:selected.payload.args,inputRefs:uniqueRefs(reflection?out.used.map(u=>u.ref):[encounter,...out.used.map(u=>u.ref)]),...(taskIntentRefs.length?{intentRef:taskIntentRefs[0]}:{})});
  }
  commands.push({op:'record_decision',id:decisionId,currentEvent:encounter,workspace,materials:inputRefs(packet.payload),input:packet,output:out,action,
    ...(reflection?{reflection:true}:{}),...(hasContinuity?{requestKey:requestId,invocationKey}:{})});
  if(hasContinuity){
    commands.push({op:'advance_subject',motivationTransition,affectTurn,extensionWrites,subject:packet.payload.continuity.subject,decision:{id:decisionId,revision:1},attempt:asRef(attempt)});
    // Validate the original delivered versions before advancing note heads, in the SAME transaction.
    commands.push(...lessonCommands);
    return store.execute({requestId,commands}).find(r=>r.type==='decision');
  }
  return store.execute({requestId,commands}).at(-1);
  }catch(error){if(attempt&&error.details)error.details={...error.details,attempt:asRef(attempt)};throw error;}
}

export function prepareReview({store,decision,feedbackRefs=[],materials=[],budgetBytes}) {
  return store.view(()=>{
    const d=record(store,decision,['decision']);
    const selected=d.output.options.find(o=>o.id===d.output.selected);
    let action=null;const feedback=uniqueRefs(feedbackRefs);
    if(d.action){
      action=store.read(d.action.id);ensure(action?.type==='action'&&action.status!=='proposed'&&action.receipt,'REVIEW_NOT_READY','actual terminal action receipt required');
      if(!feedback.some(r=>refKey(r)===refKey(action.receipt)))feedback.push(action.receipt);
    }
    ensure(feedback.length>0&&feedback.length<=16,'FEEDBACK_REQUIRED','one to sixteen actual feedback records required');
    const observations=feedback.map(ref=>record(store,ref,['event']));
    ensure(observations.every(r=>['observed','reported','tool_receipt'].includes(r.origin)),'NOT_AN_ENCOUNTER','background or imagination is not actual feedback');
    return seal('review',{format:'jingyang-review-input-v1',decision:{ref:asRef(d),selected,summary:d.output.summary,used:d.output.used},
      identityAtDecision:d.input.payload.identity,
      action:action?{ref:asRef(action),status:action.status,receipt:action.receipt}:null,
      executionStatus:action?'receipt-received':'no-execution-receipt',feedback:observations,materials:materialList(store,materials)},budgetBytes);
  });
}

export function stageReview({store,packet,output,requestId,reviewId,maxOutputBytes=32768}) {
  verify(packet,'review');text(requestId,'request id');text(reviewId,'review id');
  const out=parse(output,maxOutputBytes);exact(out,['packetId','disposition','summary','updates','questions'],'review');
  ensure(out.packetId===packet.packetId,'WRONG_PACKET','review belongs to another input');
  short(out.summary,'summary');ensure(['keep','update','defer','lookup'].includes(out.disposition),'OUTPUT_SHAPE','invalid review disposition');
  ensure(Array.isArray(out.updates)&&out.updates.length<=4&&(out.disposition==='update'?out.updates.length>0:out.updates.length===0),'OUTPUT_SHAPE','updates do not match disposition');
  ensure(Array.isArray(out.questions)&&out.questions.length<=4,'OUTPUT_LIMIT','up to four questions');out.questions.forEach(q=>short(q,'question',300));
  const delivered=new Set([...packet.payload.materials.map(m=>refKey(m.ref)),...packet.payload.feedback.map(r=>refKey(r))]), ids=new Set();
  for(const u of out.updates){
    exact(u,['id','expectedRevision','body','kind','change','confidence','status','scope','evidence'],'note proposal');
    text(u.id,'note id');ensure(!ids.has(u.id),'DUPLICATE_UPDATE','one update per note');ids.add(u.id);short(u.body,'note body',4000);
    ensure(Number.isSafeInteger(u.expectedRevision)&&u.expectedRevision>=0,'OUTPUT_SHAPE','invalid expected revision');
    if(u.expectedRevision>0)ensure(packet.payload.materials.some(m=>m.ref.id===u.id&&m.ref.revision===u.expectedRevision),'UNREAD_TARGET','read exact prior note revision before changing it');
    for(const ref of uniqueRefs(u.evidence))ensure(delivered.has(refKey(ref)),'UNDELIVERED_REFERENCE','evidence must have been delivered');
    ensure(u.evidence.every(ref=>ref.id!==u.id),'SELF_SUPPORT','proposal cannot cite itself');
    ensure(['fact_claim','interpretation','value','preference','dream','tension','feeling','skill'].includes(u.kind)
      && ['new_evidence','reinterpretation','self_report'].includes(u.change)&&['tentative','uncertain','confident'].includes(u.confidence)
      && ['current','suspended','historical'].includes(u.status),'OUTPUT_SHAPE','invalid note classification');
    exact(u.scope,['scenes','people','validFrom','validUntil'],'scope');
    ensure(Array.isArray(u.scope.scenes)&&Array.isArray(u.scope.people),'OUTPUT_SHAPE','scope arrays required');
    [...u.scope.scenes,...u.scope.people].forEach(s=>text(s,'scope entry'));
    for(const t of [u.scope.validFrom,u.scope.validUntil])ensure(t===null||Number.isSafeInteger(t)&&t>=0,'OUTPUT_SHAPE','scope time must be integer ms or null');
    ensure(u.scope.validFrom===null||u.scope.validUntil===null||u.scope.validUntil>u.scope.validFrom,'OUTPUT_SHAPE','invalid scope interval');
  }
  return store.execute({requestId,commands:[{op:'stage_review',id:reviewId,decision:packet.payload.decision.ref,action:packet.payload.action?.ref??null,
    feedbackRefs:packet.payload.feedback.map(asRef),materials:inputRefs(packet.payload),input:packet,output:out}]}).at(-1);
}

export function adoptReview({store,review,requestId}) {
  uniqueRefs([review]);return store.execute({requestId,commands:[{op:'adopt_review',review}]}).at(-1);
}

// Explicit own-history access; operational logs remain outside ordinary personal-memory search.
export function readCognitionRecord({store,ref}) {return clone(record(store,ref,['decision','review']));}

export function ablateDecisionPacket(packet,aspect) {
  const stage=continuityStage(packet?.stage)?packet.stage:'decision';verify(packet,stage);ensure(ASPECTS.includes(aspect),'INVALID_ASPECT','unknown ablation aspect');
  const payload=clone(packet.payload),removed=[],retainedShared=[];
  payload.materials=payload.materials.flatMap(m=>{
    if(!m.aspects.includes(aspect))return [m];
    const aspects=m.aspects.filter(a=>a!==aspect);
    if(aspects.length){retainedShared.push(m.ref);return [{...m,aspects}];}
    removed.push(m.ref);return [];
  });
  return {packet:seal(stage,payload,packet.budgetBytes),intervention:{aspect,removed,retainedShared,
    limitation:'removes this material channel only; current observation, prior decisions, continuity states, lookup catalogs and shared material may still contain related content'}};
}

// Network evaluators receive only a validated copy of the exact prepared messages.
export function verifiedModelInput(packet) {
  ensure(['decision','decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection','review'].includes(packet?.stage),'PACKET_STAGE','unsupported stage');
  verify(packet,packet.stage);
  return {packetId:packet.packetId,messages:clone(packet.messages),bytes:packet.bytes};
}
