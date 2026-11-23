// Resolve delivery context from persisted execution lineage, never from a goal,
// the last active chat, an owner account, or a tool's destination arguments.
export const concreteReplyScene=scene=>typeof scene==='string'&&scene.length>0&&scene!=='global'&&!scene.startsWith('agent/');
const same=(a,b)=>a&&b&&a.id===b.id&&a.revision===b.revision;
const pin=r=>({id:r.id,revision:r.revision});

export function sourceReplyRoute({read,all,event=null,action=null,task=null,subjectId=null,maxDepth=16}){
  const cache=new Map(),active=new Set();
  const rows=type=>{if(!cache.has(type))cache.set(type,[...all(type)]);return cache.get(type);};
  const no=reason=>({scene:null,reason,sources:[]});
  const yes=(scene,source)=>({scene,reason:'persisted-source',sources:[pin(source)]});
  const checkedRead=ref=>{if(!ref||typeof ref.id!=='string'||!Number.isSafeInteger(ref.revision))return null;const r=read(ref.id,ref.revision);return r&&same(r,ref)?r:null;};
  const ownDecision=d=>!subjectId||!d.input?.payload?.continuity?.subject?.id||d.input.payload.continuity.subject.id===subjectId;
  const follow=(r,fn,depth)=>{
    if(!r)return no('missing-pinned-source');
    if(depth>=maxDepth)return no('source-depth-limit');
    const key=`${r.type}:${r.id}@${r.revision}`;if(active.has(key))return no('source-cycle');
    active.add(key);try{const out=fn(r,depth+1);return {...out,sources:[pin(r),...out.sources]};}finally{active.delete(key);}
  };
  const fromAction=(a,depth)=>follow(a,(value,next)=>{
    const parents=rows('decision').filter(d=>d.action?.id===value.id);
    if(parents.length>1)return no('ambiguous-action-decision');
    if(parents.length){
      const d=parents[0];if(!ownDecision(d))return no('foreign-subject-decision');
      if(!d.currentEvent)return no('action-has-no-current-event');
      if(!(value.inputRefs??[]).some(r=>same(r,d.currentEvent)))return no('action-trigger-not-an-input');
      return fromEvent(checkedRead(d.currentEvent),next);
    }
    // Standalone legacy actions have no Decision. Only one exact event input
    // establishes a route; multiple historical inputs cannot select a chat.
    const inputs=(value.inputRefs??[]).map(checkedRead).filter(r=>r?.type==='event');
    if(inputs.length!==1)return no('ambiguous-or-missing-action-origin');
    return fromEvent(inputs[0],next);
  },depth);
  const fromTask=(t,depth)=>follow(t,(value,next)=>{
    if(subjectId&&value.subjectId&&value.subjectId!==subjectId)return no('foreign-subject-task');
    const origin=value.originDecisionRef?checkedRead(value.originDecisionRef):null;
    if(origin&&!ownDecision(origin))return no('foreign-subject-decision');
    if(concreteReplyScene(value.target))return yes(value.target,value);
    if(value.originEventRef)return fromEvent(checkedRead(value.originEventRef),next);
    if(origin?.currentEvent)return fromEvent(checkedRead(origin.currentEvent),next);
    return no('task-has-no-reply-origin');
  },depth);
  const fromEvent=(e,depth)=>follow(e,(value,next)=>{
    if(value.type!=='event')return no('source-is-not-event');
    if(value.origin==='tool_receipt'){
      const actions=rows('action').filter(a=>same(a.receipt,value));
      if(actions.length>1)return no('ambiguous-receipt-action');
      if(actions.length===1)return fromAction(actions[0],next);
      const tasks=rows('agent_task').filter(t=>same(t.feedback?.event,value)||(t.observationRefs??[]).some(r=>same(r,value)));
      if(tasks.length>1)return no('ambiguous-receipt-task');
      if(tasks.length===1)return fromTask(tasks[0],next);
    }
    return concreteReplyScene(value.scene)?yes(value.scene,value):no('no-concrete-source-scene');
  },depth);
  if(event)return fromEvent(checkedRead(event),0);
  if(action)return fromAction(checkedRead(action),0);
  if(task)return fromTask(task,0);
  return no('no-source');
}
