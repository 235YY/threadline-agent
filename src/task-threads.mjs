// Four-slot task working set over existing attention processes and events.
// A thread is a process. Objective history is queried from event.threadId; it is not
// copied into a second store, and background threads never receive full history.
import {canonical,ensure,text} from './contracts.mjs';

export const THREAD_HISTORY_UNITS=30;
const pin=r=>({id:r.id,revision:r.revision});
const atOf=e=>e?.occurredAt??e?.recordedAt??0;
const byTime=(a,b)=>atOf(a)-atOf(b)||a.id.localeCompare(b.id);

export function threadUnits({store,threadId,limit=THREAD_HISTORY_UNITS,before=null}={}){
  text(threadId,'thread id');
  ensure(Number.isSafeInteger(limit)&&limit>0&&limit<=100,'THREAD_HISTORY','limit 1..100');
  const events=[...store.all('event')].filter(e=>e.threadId===threadId&&['observed','reported'].includes(e.origin)).sort(byTime);
  const decisions=[...store.all('decision')];
  const actions=[...store.all('action')];
  const units=events.map(event=>{
    const ds=decisions.filter(d=>d.currentEvent?.id===event.id)
      .sort((a,b)=>(a.recordedAt??0)-(b.recordedAt??0)||a.id.localeCompare(b.id));
    const exchanges=ds.map(decision=>{
      const response=store.read(`${decision.id}:response`);
      const action=decision.action?actions.find(a=>a.id===decision.action.id)??null:null;
      const receipt=action?.receipt?store.read(action.receipt.id,action.receipt.revision):null;
      return {at:decision.recordedAt??0,decision:pin(decision),selected:decision.output.selected,summary:decision.output.summary,
        response:response?{ref:pin(response),body:response.body,status:response.status,claimId:response.claimId,at:response.recordedAt??0}:null,
        action:action?{ref:pin(action),tool:action.tool,args:action.args,status:action.status,at:action.recordedAt??0}:null,
        receipt:receipt?{ref:pin(receipt),body:receipt.body,origin:receipt.origin,at:receipt.recordedAt??0}:null};
    });
    const latest=Math.max(atOf(event),...exchanges.map(x=>Math.max(x.at,x.response?.at??0,x.action?.at??0,x.receipt?.at??0)));
    return {id:event.id,ref:pin(event),threadId,at:atOf(event),incoming:{body:event.body,actor:event.actor,scene:event.scene,origin:event.origin,sender:event.sender??null},exchanges,latestAt:latest};
  });
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
  const processes=frame.processes.filter(p=>!['completed','abandoned'].includes(p.status));
  const ids=new Set(processes.map(p=>p.id));
  const events=[...store.all('event')].filter(e=>!['tool_receipt','background','imagination'].includes(e.origin));
  const latest=new Map();
  for(const e of events)if(e.threadId&&ids.has(e.threadId))latest.set(e.threadId,Math.max(latest.get(e.threadId)??0,atOf(e)));
  const ranked=[...processes].sort((a,b)=>(latest.get(b.id)??b.recordedAt??0)-(latest.get(a.id)??a.recordedAt??0)||a.id.localeCompare(b.id));
  const currentThread=currentEvent?.threadId&&ids.has(currentEvent.threadId)?currentEvent.threadId:null;
  const selected=focusProcessId(frame);
  const foreground=foregroundId&&ids.has(foregroundId)?foregroundId:currentThread??selected??ranked[0]?.id??null;
  const active=[foreground,...ranked.filter(p=>p.id!==foreground).slice(0,3).map(p=>p.id)].filter(Boolean);
  const activeIds=new Set(active);
  const byId=new Map(processes.map(p=>[p.id,p]));
  const foregroundProcess=foreground?byId.get(foreground):null;
  const full=foreground?threadUnits({store,threadId:foreground,limit:historyLimit}):null;
  const background=ranked.filter(p=>activeIds.has(p.id)&&p.id!==foreground).slice(0,3).map(p=>{
    const units=threadUnits({store,threadId:p.id,limit:1}).units;
    return {id:p.id,label:p.label,status:p.status,world:p.world,summary:p.body,latestAt:latest.get(p.id)??p.recordedAt??null,
      unitCount:threadUnits({store,threadId:p.id,limit:100}).total,lastUnit:units[0]?{id:units[0].id,at:units[0].at,incoming:units[0].incoming.body,hasExchange:units[0].exchanges.length>0}:null,
      olderCursor:null,bodyLoaded:false};
  });
  return {format:'task-threads-v1',foreground:foregroundProcess?{id:foregroundProcess.id,label:foregroundProcess.label,status:foregroundProcess.status,
      world:foregroundProcess.world,summary:foregroundProcess.body,history:full,units:full?.units??[],olderCursor:full?.nextBefore??null,olderAvailable:full?.olderAvailable??false}:null,
    background,activeIds:[...active],activeCount:active.length,
    suspended:ranked.filter(p=>!activeIds.has(p.id)).map(p=>({id:p.id,label:p.label,status:p.status,latestAt:latest.get(p.id)??p.recordedAt??null})),
    unassignedCount:events.filter(e=>!e.threadId||!ids.has(e.threadId)).length,
    meaning:'one-foreground-full-history-plus-three-background-metadata; no-status-mutation; no-event-duplication; older pages explicit'};
}
function focusProcessId(frame){
  const selected=(frame?.focus?.selection??[]).filter(s=>s.kind==='process');
  return selected.length?selected[0].id:null;
}
