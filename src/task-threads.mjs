// Four-slot task working set over existing attention processes and events.
// A thread is a process. Legacy threadId and subject-explicit links select history; it is not
// copied into a second store, and background threads never receive full history.
import {canonical,digest,ensure,text,uniqueRefs} from './contracts.mjs';
import {normalizeMessage} from './message.mjs';

export const THREAD_HISTORY_UNITS=30;
const fixedTaskRef=r=>typeof r?.id==='string'&&r.id.length>0&&Number.isSafeInteger(r.revision)&&r.revision>0;
export function taskProcessSource({store,subjectId,processId,originDecisionRef}){
  if(typeof processId!=='string'||!processId||!fixedTaskRef(originDecisionRef))return null;
  const d=store.read(originDecisionRef.id,originDecisionRef.revision);
  if(d?.type!=='decision'||d.input?.payload?.continuity?.subject?.id!==subjectId)return null;
  const choice=d.output.options.find(o=>o.id===d.output.selected),action=fixedTaskRef(d.action)?store.read(d.action.id,d.action.revision):null;
  if(choice?.kind!=='act'||choice.payload.tool!=='start_agent_task'||choice.payload.args.processId!==processId||action?.tool!=='start_agent_task'||action.args.processId!==processId)return null;
  const context=d.input.payload.continuity.attention,frame=fixedTaskRef(context?.frame)?store.read(context.frame.id,context.frame.revision):null;
  const delivered=context?.processes?.find(p=>p.id===processId),source=frame?.processes?.find(p=>p.id===processId&&p.revision===delivered?.revision);
  const head=frame?store.read(frame.id):null;
  if(frame?.subject!==subjectId||!source||head?.subject!==subjectId||!head.processes.some(p=>p.id===processId))return null;
  return {decision:d,action,process:{id:source.id,revision:source.revision},frame:context.frame};
}
function taskHistoryUnits({store,subjectId,threadId}){
  if(!subjectId)return [];
  const units=[];
  for(const task of store.all('agent_task')){
    if(task.subjectId!==subjectId||task.processId!==threadId)continue;
    const source=taskProcessSource({store,subjectId,processId:threadId,originDecisionRef:task.originDecisionRef});
    if(!source||task.id!=='task:'+source.action.id)continue;
    if(task.originEventRef&&!fixedTaskRef(task.originEventRef))continue;
    const origin=task.originEventRef?store.read(task.originEventRef.id,task.originEventRef.revision):null;
    if(source.decision.currentEvent&&!sameTaskRef(task.originEventRef,source.decision.currentEvent))continue;
    const evidence=[{role:'task-start',type:'agent_task',task:{id:task.id,revision:task.revision},originDecisionRef:task.originDecisionRef,action:{id:source.action.id,revision:source.action.revision},processId:task.processId,at:task.createdAt}];
    const add=(ref,role,record=task)=>{
      if(!fixedTaskRef(ref)||evidence.some(e=>sameTaskRef(e.ref,ref)))return;
      const e=store.read(ref.id,ref.revision);if(e?.type!=='event'||!store.subjectObservation(subjectId,e.id))return;
      const generatedOrigin=role==='task-origin'&&e.origin==='reported'&&e.source?.system==='turn-driver'&&e.id==='obs:task-origin:'+task.id;
      const isObservation=role==='observation'&&e.origin==='tool_receipt'&&e.source?.system==='agent-runtime'&&e.id.startsWith('agent-observation:'+task.id+':')&&e.source.key===e.id;
      const isResult=role==='result'&&e.origin==='tool_receipt'&&e.source?.system==='agent-runtime'&&e.id.startsWith('agent-result:'+task.id+':')&&e.source.key===e.id;
      if(!(generatedOrigin||isObservation||isResult))return;
      let completeness=null;
      if(isObservation){
        const observation=(task.observations??[]).find(o=>{
          if(o.at!==e.occurredAt||!e.id.endsWith(':'+o.tool+(o.late?':late:'+o.operationId:'')))return false;
          if(e.message){try{return canonical(e.message)===canonical(normalizeMessage({format:'jingyang-message-v1',role:'tool',content:o.result?.content}));}catch{return false;}}
          try{return canonical(JSON.parse(e.body))===canonical(o);}catch{return e.body.length===6000&&JSON.stringify(o).length>6000;}
        });
        if(!observation)return;
        if(!(task.decisionRefs??[]).some(ref=>{const d=typeof ref==='string'?store.read(ref,1):ref?.id&&Number.isSafeInteger(ref.revision)?store.read(ref.id,ref.revision):null;
          if(d?.type!=='decision'||d.input?.payload?.task?.id!==task.id||d.input.payload.continuity.subject.id!==subjectId)return false;
          const chosen=d.output.options.find(o=>o.id===d.output.selected),identity=typeof ref==='string'?ref:canonical(ref);
          return chosen?.payload?.tool===observation.tool&&task.toolOps?.[identity+':'+observation.tool+':'+canonical(chosen.payload.args??{})]?.operationId===observation.operationId;
        }))return;
        completeness={format:e.message?'structured-message':'json',truncated:!e.message&&JSON.stringify(observation).length>6000};
      }
      if(isResult){
        if(record.subjectId!==subjectId||record.processId!==threadId||!sameTaskRef(record.originDecisionRef,task.originDecisionRef)||record.feedback?.status!=='recorded'||!sameTaskRef(record.feedback.event,ref))return;
        const key=`agent-result:${record.id}:${record.status}:${digest({control:record.controlRevision??0,steps:record.stepCount,decision:record.decisionRefs?.at(-1)??null,result:record.result??null,reason:record.blockedReason??null}).slice(0,24)}`;
        if(e.id!==key||record.feedback.key!==key)return;
        completeness={format:'json',truncated:JSON.stringify({taskId:record.id,intentRef:record.intentRef??null,goal:record.goal,status:record.status,result:record.result,blockedReason:record.blockedReason}).length>6000};
      }
      evidence.push({ref:{id:e.id,revision:e.revision},role,origin:e.origin,source:e.source,scene:e.scene,threadId:e.threadId??null,body:e.body,...(e.message?{message:e.message}:{}),...(completeness?{completeness}:{}),...(isResult?{recordedTask:{id:record.id,revision:record.revision},statusAtRecord:record.status,historical:!sameTaskRef(ref,task.feedback?.event)}:{}),occurredAt:e.occurredAt??e.recordedAt});
    };
    if(origin)add(task.originEventRef,'task-origin');
    for(const ref of task.observationRefs??[])add(ref,'observation');
    // A resumed Task replaces feedback at its head; original fixed receipts remain in its versions.
    for(let revision=1;revision<=task.revision;revision++){
      const record=store.read(task.id,revision);if(record?.feedback?.status==='recorded')add(record.feedback.event,'result',record);
    }
    units.push({id:'task-evidence:'+task.id,threadId,kind:'task-execution-evidence',task:{id:task.id,revision:task.revision},processId:threadId,processSource:{ref:source.process,frame:source.frame},originDecisionRef:task.originDecisionRef,originEventRef:task.originEventRef??null,at:task.createdAt,latestAt:Math.max(task.updatedAt,...evidence.map(e=>e.occurredAt??e.at)),goal:task.goal,status:task.status,evidence,exchanges:[],incoming:{body:'任务执行记录：'+task.goal,origin:'task-record',scene:task.target??null},meaning:'typed Task evidence, not an attributed external message; original event types remain unchanged'});
  }
  return units;
}
const sameTaskRef=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
export const EVENT_PROCESS_THEORY='event-process-v1';
export const eventProcessId=(subjectId,event,processId)=>`extension:${subjectId}:${EVENT_PROCESS_THEORY}:${digest([event,processId])}`;
export function eventProcessLinks({store,subjectId}){
  if(!subjectId)return [];
  const rows=typeof store.extensionRecords==='function'?store.extensionRecords({stateType:'event-process-link',owner:subjectId}):store.all('extension_record');
  return [...rows].filter(r=>r.owner===subjectId&&r.theory===EVENT_PROCESS_THEORY&&r.stateType==='event-process-link'&&r.schemaVersion==='1');
}
// Only complete delivered events qualify; recent snippets and directories are not event bodies.
export function eventProcessEvents(input){
  const refs=[];
  if(input.current&&['observed','reported'].includes(input.current.origin)&&typeof input.current.body==='string')refs.push(input.current);
  for(const m of input.materials??[])if(m.record?.type==='event'&&['observed','reported'].includes(m.record.origin)&&typeof m.record.body==='string')refs.push(m.ref);
  for(const u of input.continuity?.threads?.foreground?.units??[])if(u.ref&&typeof u.incoming?.body==='string')refs.push(u.ref);
  return uniqueRefs(refs.map(r=>({id:r.id,revision:r.revision})));
}
const pin=r=>({id:r.id,revision:r.revision});
const atOf=e=>e?.occurredAt??e?.recordedAt??0;
const byTime=(a,b)=>atOf(a)-atOf(b)||a.id.localeCompare(b.id);

export function threadUnits({store,threadId,subjectId=null,limit=THREAD_HISTORY_UNITS,before=null}={}){
  text(threadId,'thread id');
  ensure(Number.isSafeInteger(limit)&&limit>0&&limit<=100,'THREAD_HISTORY','limit 1..100');
  const links=eventProcessLinks({store,subjectId}).filter(r=>r.value.status==='active'&&r.value.processId===threadId);
  const pinned=new Set(links.map(r=>canonical(r.value.event)));
  const indexed=typeof store.eventsInThread==='function';
  // Indexed path: this thread's own events plus explicitly linked ones; decisions per event.
  const candidates=indexed?[...store.eventsInThread(threadId),...links.map(r=>store.read(r.value.event.id,r.value.event.revision)).filter(Boolean)]:store.all('event');
  const seenEvent=new Set();
  const events=[...candidates].filter(e=>{if(seenEvent.has(e.id))return false;seenEvent.add(e.id);return (e.threadId===threadId||pinned.has(canonical(pin(e))))&&['observed','reported'].includes(e.origin)&&(!subjectId||store.subjectObservation(subjectId,e.id));}).sort(byTime);
  const allDecisions=indexed?null:[...store.all('decision')];
  const decisionsFor=id=>indexed?store.decisionsForEvent(id):allDecisions.filter(d=>d.currentEvent?.id===id);
  const actions=indexed?null:[...store.all('action')];
  const actionOf=ref=>indexed?store.read(ref.id):actions.find(a=>a.id===ref.id)??null;
  const units=events.map(event=>{
    const ds=decisionsFor(event.id).filter(d=>d.currentEvent?.id===event.id&&!d.input?.payload?.task?.id&&(!subjectId||d.input?.payload?.continuity?.subject?.id===subjectId))
      .sort((a,b)=>(a.recordedAt??0)-(b.recordedAt??0)||a.id.localeCompare(b.id));
    const exchanges=ds.map(decision=>{
      const response=store.read(`${decision.id}:response`);
      const action=decision.action?actionOf(decision.action):null;
      const receipt=action?.receipt?store.read(action.receipt.id,action.receipt.revision):null;
      return {at:decision.recordedAt??0,decision:pin(decision),selected:decision.output.selected,summary:decision.output.summary,
        response:response?{ref:pin(response),body:response.body,status:response.status,claimId:response.claimId,at:response.recordedAt??0}:null,
        action:action?{ref:pin(action),tool:action.tool,args:action.args,status:action.status,at:action.recordedAt??0}:null,
        receipt:receipt?{ref:pin(receipt),body:receipt.body,origin:receipt.origin,at:receipt.recordedAt??0}:null};
    });
    const latest=Math.max(atOf(event),...exchanges.map(x=>Math.max(x.at,x.response?.at??0,x.action?.at??0,x.receipt?.at??0)));
    return {id:event.id,ref:pin(event),threadId,at:atOf(event),incoming:{body:event.body,actor:event.actor,scene:event.scene,origin:event.origin,sender:event.sender??null},exchanges,latestAt:latest};
  });
  units.push(...taskHistoryUnits({store,subjectId,threadId}));units.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  const total=units.length;
  let selected=units;
  if(before!==null){
    const index=units.findIndex(u=>u.id===before);
    ensure(index>=0,'THREAD_CURSOR','unknown thread history cursor');
    selected=units.slice(Math.max(0,index-limit),index);
    return {format:'thread-history-v1',threadId,units:selected,total,nextBefore:index>selected.length?units[index-selected.length]?.id??null:null,olderAvailable:index>selected.length};
  }
  selected=units.slice(-limit);
  return {format:'thread-history-v1',threadId,units:selected,total,nextBefore:units.length>selected.length?units[units.length-selected.length]?.id??null:null,olderAvailable:units.length>selected.length};
}

export function taskThreads({store,frame,currentEvent=null,foregroundId=null,historyLimit=THREAD_HISTORY_UNITS}={}){
  ensure(frame?.processes,'TASK_THREADS','attention frame required');
  const subjectId=frame.subject;
  const links=eventProcessLinks({store,subjectId}).filter(r=>r.value.status==='active');
  const processes=frame.processes.filter(p=>!['completed','abandoned'].includes(p.status));
  const ids=new Set(processes.map(p=>p.id));
  const indexed=typeof store.eventsInThread==='function';
  const pool=indexed?[...processes.flatMap(p=>store.eventsInThread(p.id)),...links.filter(r=>ids.has(r.value.processId)).map(r=>store.read(r.value.event.id,r.value.event.revision)).filter(Boolean)]:store.all('event');
  const seenPool=new Set();
  const events=[...pool].filter(e=>{if(seenPool.has(e.id))return false;seenPool.add(e.id);return !['tool_receipt','background','imagination'].includes(e.origin)&&(!subjectId||store.subjectObservation(subjectId,e.id));});
  const latest=new Map();
  const owners=e=>[...new Set([e.threadId,...links.filter(r=>canonical(r.value.event)===canonical(pin(e))).map(r=>r.value.processId)].filter(id=>id&&ids.has(id)))];
  for(const e of events)for(const id of owners(e))latest.set(id,Math.max(latest.get(id)??0,atOf(e)));
  const ranked=[...processes].sort((a,b)=>(latest.get(b.id)??b.recordedAt??0)-(latest.get(a.id)??a.recordedAt??0)||a.id.localeCompare(b.id));
  const currentThread=currentEvent?.threadId&&ids.has(currentEvent.threadId)?currentEvent.threadId:null;
  const selected=focusProcessId(frame);
  const foreground=foregroundId&&ids.has(foregroundId)?foregroundId:currentThread??selected??ranked[0]?.id??null;
  const active=[foreground,...ranked.filter(p=>p.id!==foreground).slice(0,3).map(p=>p.id)].filter(Boolean);
  const activeIds=new Set(active);
  const byId=new Map(processes.map(p=>[p.id,p]));
  const foregroundProcess=foreground?byId.get(foreground):null;
  const full=foreground?threadUnits({store,subjectId,threadId:foreground,limit:historyLimit}):null;
  const background=ranked.filter(p=>activeIds.has(p.id)&&p.id!==foreground).slice(0,3).map(p=>{
    const units=threadUnits({store,subjectId,threadId:p.id,limit:1}).units;
    return {id:p.id,label:p.label,status:p.status,world:p.world,summary:p.body,latestAt:latest.get(p.id)??p.recordedAt??null,
      unitCount:threadUnits({store,subjectId,threadId:p.id,limit:100}).total,lastUnit:units[0]?{id:units[0].id,at:units[0].at,incoming:units[0].incoming.body,hasExchange:units[0].exchanges.length>0}:null,
      olderCursor:null,bodyLoaded:false};
  });
  return {format:'task-threads-v1',foreground:foregroundProcess?{id:foregroundProcess.id,label:foregroundProcess.label,status:foregroundProcess.status,
      world:foregroundProcess.world,summary:foregroundProcess.body,history:full,units:full?.units??[],olderCursor:full?.nextBefore??null,olderAvailable:full?.olderAvailable??false}:null,
    background,activeIds:[...active],activeCount:active.length,
    suspended:ranked.filter(p=>!activeIds.has(p.id)).map(p=>({id:p.id,label:p.label,status:p.status,latestAt:latest.get(p.id)??p.recordedAt??null})),
    // Indexed pool holds only assigned events, so count the rest in SQL instead of loading them.
    unassignedCount:indexed&&subjectId&&typeof store.countAdmittedEvents==='function'
      ?Math.max(0,store.countAdmittedEvents({subjectId,excludeOrigins:['tool_receipt','background','imagination']})-events.filter(e=>owners(e).length>0).length)
      :events.filter(e=>owners(e).length===0).length,
    meaning:'one-foreground-full-history-plus-three-background-metadata; no-status-mutation; no-event-duplication; older pages explicit'};
}
function focusProcessId(frame){
  const selected=(frame?.focus?.selection??[]).filter(s=>s.kind==='process');
  return selected.length?selected[0].id:null;
}
