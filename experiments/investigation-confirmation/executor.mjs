// Research host glue. All claims, permissions, receipts and task creation remain
// in the existing brain service; this is not a planner or an action generator.
import {canonical,ensure} from '../../src/contracts.mjs';
const CONTROLS=['start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task'];
export async function executeProposed({service,outbox,scene,subjectId,readOnlyTools=[]}){
  const executions=[];
  for(const item of outbox??[]){
    if(item.kind!=='act')continue;
    const action=service.store.read(item.action?.id);
    ensure(action?.type==='action','ACTION_REQUIRED','only adopted durable actions can execute');
    const decision=[...service.store.all('decision')].find(d=>d.action?.id===action.id);
    ensure(decision?.input?.payload?.continuity?.subject?.id===subjectId,'ACTION_OWNER','action must belong to this synthetic subject decision');
    ensure(item.tool===action.tool&&canonical(item.args)===canonical(action.args),'ACTION_CHANGED','outbox cannot change an adopted tool or arguments');
    ensure(readOnlyTools.includes(action.tool)||CONTROLS.includes(action.tool),'READ_ONLY_SCOPE','only frozen read-only tools and task controls are supported');
    if(action.status==='succeeded'){executions.push({action:{id:action.id,revision:action.revision},status:action.status,replayed:true,receipt:action.receipt});continue;}
    ensure(action.status==='proposed','ACTION_OUTCOME_UNSAFE','failed, claimed or unknown operations are never automatically retried');
    if(action.tool==='start_agent_task')ensure(Array.isArray(action.args.allowedTools)&&action.args.allowedTools.length>0&&action.args.allowedTools.every(t=>readOnlyTools.includes(t)),'READ_ONLY_SCOPE','task must explicitly use a nonempty subset of this fixture whitelist; never trigger service defaults');
    const result=await service.dispatch([item],{scene,execute:true});
    const current=service.store.read(action.id),event=current.receipt?service.store.read(current.receipt.id,current.receipt.revision):null;
    executions.push({action:{id:current.id,revision:current.revision},tool:current.tool,status:current.status,receipt:current.receipt??null,event,result});
    const invalid=result.some(r=>r?.ok===false||r?.complete===false||r?.error||['interrupted','unknown','failed'].includes(r?.status));
    ensure(!invalid&&current.status==='succeeded'&&event?.origin==='tool_receipt','TOOL_STEP_FAILED','preserve failed/incomplete/unknown tool result and stop; do not retry');
    let body;try{body=JSON.parse(event.body);}catch{}
    ensure(body?.ok!==false&&body?.complete!==false&&!body?.error,'TOOL_STEP_FAILED','explicit unsuccessful tool payload stops the batch');
  }
  return executions;
}
