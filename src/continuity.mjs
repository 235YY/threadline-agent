import {ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {stateCard,normalizeDomains} from './personal-state.mjs';
import {attentionId,attentionView} from './attention.mjs';
import {associationCandidates} from './association.mjs';
import {streamInfo} from './streams.mjs';
import {mindProjection} from './mind.mjs';
import {anchorView,anchorKey} from './anchor.mjs';
import {recentContext} from './recent-context.mjs';
import {socialProjection} from './social-projection.mjs';
import {taskThreads} from './task-threads.mjs';
const ref=x=>({id:x.id,revision:x.revision});

export function initializeSubject({store,subjectId,requestId,maxForeground=8}) {
  return store.execute({requestId,commands:[{op:'initialize_subject',id:subjectId,maxForeground}]}).at(-1);
}
export function admitSubjectEvent({store,subjectId,event,requestId}) {
  return store.execute({requestId,commands:[{op:'admit_subject_event',subjectId,event}]}).at(-1);
}
export function readPersonalState({store,subjectId,state,detail=true,domains=true,evidence=false}) {
  uniqueRefs([state]);const value=store.read(state.id,state.revision);
  ensure(value?.type==='personal_state'&&value.subject===subjectId,'MISSING_STATE','unknown own state');
  return stateCard(value,{historical:store.read(value.id).revision!==value.revision,detail,domains,evidence});
}
const aboutKey=r=>`${r.kind}:${r.id}`;
function deriveEventAbout({store,subjectId,currentEvent,frame}){
  const refs=[{kind:'self',id:subjectId}];
  if(currentEvent?.scene)refs.push({kind:'scene',id:currentEvent.scene});
  if(currentEvent?.sender?.entityId)refs.push({kind:'entity',id:currentEvent.sender.entityId});
  else if(currentEvent?.actor){
    const actor=String(currentEvent.actor);
    const entity=[...store.all('entity')].find(e=>e.id===actor||e.name===actor||(e.aliases??[]).includes(actor));
    if(entity)refs.push({kind:'entity',id:entity.id});
  }
  if(currentEvent?.id)refs.push({kind:'event',id:currentEvent.id});
  for(const p of frame?.processes??[])if((p.basis??[]).some(b=>b.id===currentEvent?.id&&b.revision===currentEvent?.revision))refs.push({kind:'process',id:p.id});
  return [...new Map(refs.map(r=>[aboutKey(r),r])).values()];
}
// Deliver whole semantic bodies or leave a bounded gap; never pass a truncated body as a full state.
function memoryBodies(rows,{cap,maxBytes,detail=false}){
  const items=[];let bytes=0;
  for(const r of rows){
    if(items.length>=cap)break;
    const item={ref:{id:r.id,revision:r.revision},body:String(r.body??''),about:Array.isArray(r.about)?r.about:[],domains:Array.isArray(r.domains)?r.domains:[],
      ...(detail?{basis:r.basis??null,stage:r.stage??'recent'}:{}),asOf:r.recordedAt??null};
    const size=Buffer.byteLength(JSON.stringify(item));
    if(bytes+size>maxBytes)continue;
    items.push(item);bytes+=size;
  }
  return {items,bytes,omitted:rows.length-items.length,bodyPolicy:'whole-body-or-omitted'};
}
export function shortTermView({store,subjectId,about=null,domains=null,maxWindow=50,maxBodies=8,maxBytes=16000}){
  const domainSet=domains?.length?new Set(domains):null;
  const aboutSet=about?.length?new Set(about.map(aboutKey)):null;
  const rows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.kind==='impression'&&(!r.stage||r.stage==='recent')&&r.status==='open')
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id));
  const window=rows.slice(0,maxWindow);
  const eligible=window.filter(r=>{
    if(aboutSet){const refs=Array.isArray(r.about)?r.about:(r.anchor?[r.anchor]:[]);if(!refs.some(x=>aboutSet.has(aboutKey(x))))return false;}
    if(domainSet){const ds=Array.isArray(r.domains)?r.domains:[];if(!ds.some(d=>domainSet.has(d)))return false;}
    return true;
  });
  const {items,bytes}=memoryBodies(eligible,{cap:maxBodies,maxBytes});
  return {format:'short-term-v1',window:window.length,windowRefs:window.map(r=>({id:r.id,revision:r.revision})),eligible:eligible.length,items,omitted:eligible.length-items.length,bytes,meaning:'dynamic-window-not-message-list; no-reinforcement'};
}
export function impressionMaintenanceView({store,subjectId,recent=null,compressed=null,maxSourceBodies=8,maxSourceBytes=16000}={}){
  const recentRows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.kind==='impression'&&(!r.stage||r.stage==='recent')&&r.status==='open')
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id));
  const compressedRows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.kind==='impression'&&r.stage==='compressed'&&r.status==='open')
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id));
  const recentIds=new Set((recent?.items??[]).map(x=>x.ref.id));
  const older=memoryBodies(recentRows.filter(r=>!recentIds.has(r.id)),{cap:maxSourceBodies,maxBytes:maxSourceBytes});
  const due=recentRows.length>20||compressedRows.length>=30;
  return {format:'impression-maintenance-v1',due,
    recentCount:recentRows.length,recentCap:20,compressedCount:compressedRows.length,compressedCap:30,
    recentOverflow:Math.max(0,recentRows.length-20),compressionFull:compressedRows.length>=30,
    olderRecent:older.items,olderRecentOmitted:older.omitted,olderRecentBytes:older.bytes,
    compressedCandidates:compressedRows.slice(0,30).map(r=>({ref:{id:r.id,revision:r.revision},body:[...String(r.body??'')].slice(0,512).join(''),representation:'directory-excerpt-not-full-source',about:Array.isArray(r.about)?r.about:[],domains:Array.isArray(r.domains)?r.domains:[],asOf:r.recordedAt??null})),
    meaning:'host-identifies-maintenance-opportunity; subject-decides merge/retire/keep/promote; no-auto-compression; compressed-units-cannot-be-sources'};
}
export function subjectiveMemoryView({store,subjectId,about=null,domains=null,maxRecent=20,maxCompressed=30,maxRecentBytes=24000,maxCompressedBytes=24000,maxSourceBodies=8}={}){
  const domainSet=domains?.length?new Set(domains):null;
  const aboutSet=about?.length?new Set(about.map(aboutKey)):null;
  const matches=r=>{
    if(aboutSet){const refs=Array.isArray(r.about)?r.about:(r.anchor?[r.anchor]:[]);if(!refs.some(x=>aboutSet.has(aboutKey(x))))return false;}
    if(domainSet){const ds=Array.isArray(r.domains)?r.domains:[];if(!ds.some(d=>domainSet.has(d)))return false;}
    return true;
  };
  const recentRows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.kind==='impression'&&(!r.stage||r.stage==='recent')&&r.status==='open')
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id));
  const compressedRows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.kind==='impression'&&r.stage==='compressed'&&r.status==='open')
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||b.id.localeCompare(a.id));
  const take=(rows,cap,byteCap)=>memoryBodies(rows,{cap,maxBytes:byteCap,detail:true});
  const recent=take(recentRows.filter(matches),maxRecent,maxRecentBytes);
  const compressed=take(compressedRows.filter(matches),maxCompressed,maxCompressedBytes);
  return {format:'subjective-memory-v2',recent:{cap:20,count:recentRows.length,items:recent.items,omitted:recent.omitted,bytes:recent.bytes},
    compressed:{cap:30,count:compressedRows.length,items:compressed.items,omitted:compressed.omitted,bytes:compressed.bytes},
    maintenance:impressionMaintenanceView({store,subjectId,recent,compressed,maxSourceBodies}),
    meaning:'20-recent-full-plus-30-theme-units; compressed-not-recursive; no-auto-note; no-auto-compression'};
}
// Bounded state directory. Filter before sort/slice so a matching state
// cannot be discarded merely because it ranked below the cap.
export function stateCandidates({store,subjectId,workbenchFocus=false,mind=false,domains=null,about=null,anchor=null,scope=null,limit=8,extended=false}={}){
  if(!workbenchFocus||!mind)return {items:[],omitted:0,total:0};
  const domainFilter=domains===null||domains===undefined||domains.length===0?null:normalizeDomains(domains,'state candidate domains');
  const aboutFilter=about?.length?new Set(about.map(aboutKey)):null;
  const anchorWanted=anchor?anchorKey(anchor):null;
  const scopeWanted=scope?[...new Set(scope)]:null;
  let rows=[...store.all('personal_state')].filter(r=>r.subject===subjectId&&r.status!=='closed'&&r.mind);
  if(domainFilter)rows=rows.filter(r=>Array.isArray(r.domains)&&r.domains.some(d=>domainFilter.includes(d)));
  if(aboutFilter)rows=rows.filter(r=>{const refs=Array.isArray(r.about)?r.about:(r.anchor?[r.anchor]:[]);return refs.some(x=>aboutFilter.has(aboutKey(x)));});
  if(anchorWanted)rows=rows.filter(r=>anchorKey(r.anchor)===anchorWanted);
  if(scopeWanted)rows=rows.filter(r=>Array.isArray(r.scope)&&r.scope.some(s=>scopeWanted.includes(s)));
  const sorted=rows.sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||a.id.localeCompare(b.id));
  const page=sorted.slice(0,limit).map(r=>extended?{ref:{id:r.id,revision:r.revision},kind:r.kind,role:r.mind.role,recordType:'personal_state',domains:Array.isArray(r.domains)?r.domains:[],about:Array.isArray(r.about)?r.about:[]}:{ref:{id:r.id,revision:r.revision},kind:r.kind,role:r.mind.role});
  return {items:page,omitted:Math.max(0,sorted.length-page.length),total:sorted.length};
}
export function continuityInput({store,subjectId,stateRefs=[],detail=false,evidenceDetail=false,currentEvent=null,mind=false,workbenchFocus=false,focusProcessIds=[],subjectiveDomains=false,subjectiveMemory=false,subjectiveMemoryV2=false,taskThreads:includeThreads=false,anchorDirectory=false,socialContext=false,now=null,candidateDomains=null,candidateAnchor=null,candidateScope=null,motivationProjection=null,internalSources=[]}) {
  text(subjectId,'subject id');ensure(typeof detail==='boolean','INVALID_INPUT','detail must be boolean');
  return store.view(()=>{
    const subject=store.read(subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize the subject first');
    const frame=store.read(attentionId(subjectId));
  // Candidate directory: her own B/C/R/Z states appear as focus candidates, but no body.
  // Only explicit focus or explicit residence delivers the body on the next projection.
  const currentRecord=currentEvent?store.read(currentEvent.id,currentEvent.revision):null;
  const eventRefs=currentRecord?deriveEventAbout({store,subjectId,currentEvent:currentRecord,frame}):[];
  const candidateSet=stateCandidates({store,subjectId,workbenchFocus,mind,domains:candidateDomains,about:(subjectiveMemory||subjectiveMemoryV2)?eventRefs:null,anchor:candidateAnchor,scope:candidateScope,extended:subjectiveDomains===true||subjectiveMemory===true});
  const candidateItems=candidateSet.items;
  const shortTerm=subjectiveMemory&&!subjectiveMemoryV2?shortTermView({store,subjectId,about:eventRefs,domains:candidateDomains}):null;
  const subjective=subjectiveMemoryV2?subjectiveMemoryView({store,subjectId,about:eventRefs,domains:candidateDomains}):null;
  const shortTermKeys=new Set((shortTerm?.windowRefs??[]).map(r=>`${r.id}@${r.revision}`));
  const history=subjectiveMemory&&!subjectiveMemoryV2&&currentRecord
    ?anchorView({store,subjectId,currentEvent:currentRecord,limit:64,mode:'directory',about:eventRefs,includeHistorical:true,includeImpressions:true,onlyImpressions:true})
    :null;
  const historicalImpressions=history?{...history,records:history.records.filter(r=>!shortTermKeys.has(`${r.ref.id}@${r.ref.revision}`))}:undefined;
  const associations=currentEvent?associationCandidates({store,subjectId,currentEvent,limit:6}):[];
  const stream=currentRecord?.scene?streamInfo(currentRecord.scene):null;
  const view=frame?attentionView(frame,{read:(id,rev)=>store.read(id,rev),currentEvent,workbenchFocus,focusProcessIds,stateCandidates:candidateItems,associationCandidates:associations,maxForeground:subject.maxForeground}):null;
    const foreground=(view?view.foreground.map(ref):subject.foreground).map(pinned=>{
      const value=store.read(pinned.id,pinned.revision);ensure(value?.type==='personal_state'&&value.subject===subjectId&&value.status!=='closed'
        &&store.read(value.id).revision===pinned.revision,'BROKEN_FOREGROUND','invalid foreground state');
      return stateCard(value,{detail,domains:subjectiveDomains,evidence:evidenceDetail});
    });
    // Her explicit state focus: next projection carries the body as recalled; unselected stays directory-only.
    const focusedStates=(view?.metadata?.focusSupport?.selection??[]).filter(s=>s.kind==='state')
      .map(s=>{try{const head=store.read(s.id);return head?{id:s.id,revision:head.revision}:null;}catch{return null;}}).filter(Boolean);
    const seen=new Set(foreground.map(x=>refKey(x.ref))),recalled=uniqueRefs([...stateRefs,...focusedStates]).filter(r=>!seen.has(refKey(r)))
      .map(state=>readPersonalState({store,subjectId,state,detail,domains:subjectiveDomains,evidence:evidenceDetail}));
    let lastReaction=null;
    if(subject.lastDecision){
      const reaction=readReaction({store,subjectId,decision:subject.lastDecision});
      const decision=store.read(subject.lastDecision.id,subject.lastDecision.revision);
      const unavailable=decision.input?.packetUnavailable===true;
      lastReaction={decision:subject.lastDecision,fromScene:unavailable?null:decision.input.payload?.workspace?.scene??null,
        kind:reaction.choice?.kind??'unavailable',packetUnavailable:unavailable,
        utterance:reaction.choice?.kind==='respond'?reaction.choice.payload?.text??null:null,expressionChoice:reaction.expressionChoice??null,
        responseStatus:reaction.response?.status??'no-response-intent',at:decision.recordedAt??null};
    }
    const projection=mind?mindProjection({records:[...foreground,...recalled].map(x=>store.read(x.ref.id,x.ref.revision)),readHead:id=>store.read(id)}):null;
    const anchors=anchorView({store,subjectId,currentEvent:currentRecord,limit:12,mode:anchorDirectory?'directory':'legacy',domains:candidateDomains,about:subjectiveMemory&&anchorDirectory?eventRefs:null});
    if(view&&(subjectiveDomains||subjectiveMemory))view.metadata.stateCandidatesOmitted=candidateSet.omitted;
    const recent=recentContext({store,subjectId,currentEvent:currentRecord,scene:currentRecord?.scene??null,limit:50});
    const threads=includeThreads&&frame?taskThreads({store,frame,currentEvent:currentRecord}):null;
    ensure(Array.isArray(internalSources)&&internalSources.length<=16,'INTERNAL_SOURCE_LIMIT','bounded host-provided internal sources');
    for(const source of internalSources){uniqueRefs([source.ref]);ensure(['computed-internal','interpretation-history'].includes(source.kind)&&source.value&&typeof source.value==='object','INTERNAL_SOURCE','typed host internal source required');}
    const motivation=motivationProjection;
    const intents=[...store.all('intent')].filter(x=>x.subject===subjectId&&['open','pursuing','deferred'].includes(x.status)).sort((a,b)=>(Number(a.status==='deferred')-Number(b.status==='deferred'))||(a.dueAt??Infinity)-(b.dueAt??Infinity)||String(a.id).localeCompare(String(b.id))).slice(0,8).map(x=>({id:x.id,revision:x.revision,goal:x.goal,status:x.status,nextAction:x.nextAction??null,dueAt:x.dueAt??null}));
    const social=socialContext?socialProjection({store,subjectId,currentEvent:currentRecord,attentionFrame:frame,now}):null;
    return {...(internalSources.length?{internalSources}:{}),...(motivation?{motivation}:{}),...(intents.length?{intents}:{}),...(social?{social}:{}),subject:ref(subject),maxForeground:subject.maxForeground,...(subject.attentionPolicy!==undefined?{attentionPolicy:subject.attentionPolicy}:{}),foreground,recalled,
      lastReaction,pendingObservations:store.subjectInbox({subjectId,limit:16}),detail,...(stream?{stream}:{}),...(view?{attention:{...view.metadata,...(includeThreads?{eventProcessSupport:{enabled:true,format:'event-process-v1',events:[]}}:{})}}:{}),...(projection?{mind:projection}:{}),...(anchors.records.length?{anchors}:{}),...(recent?{recent}:{}),...(threads?{threads}:{}),...((subjectiveMemory||subjectiveMemoryV2)&&eventRefs.length?{eventAbout:eventRefs}:{}),...(shortTerm?{shortTerm}:{}),...(subjective?{subjectiveMemory:subjective}:{}),...(historicalImpressions?.records.length?{historicalImpressions}:{}),
      ...(mind&&workbenchFocus?{selfProtocol:{format:'self-protocol-v1',enabled:true}}:{}),
      ...(view?{memoryProtocol:{format:'memory-protocol-v1',enabled:true}}:{}),
      ...(view?{silenceProtocol:{format:'silence-protocol-v1',enabled:true}}:{})};
  });
}
export function readReaction({store,subjectId,decision}) {
  uniqueRefs([decision]);const record=store.read(decision.id,decision.revision);
  ensure(record?.type==='decision'&&record.input.payload.continuity?.subject.id===subjectId,'MISSING_REACTION','unknown own reaction');
  const unavailable=record.input?.packetUnavailable===true;
  const selected=record.output.options.find(o=>o.id===record.output.selected),response=store.read(`${record.id}:response`);
  const before=record.input.payload.continuity.subject,after=store.read(before.id,before.revision+1);
  ensure(after?.type==='subject'&&after.lastDecision?.id===record.id,'MISSING_CONTINUATION','missing committed state checkpoint');
  return {decision:ref(record),currentEvent:record.currentEvent,workspace:record.workspace,packetUnavailable:unavailable,
    stateBefore:unavailable?[]:[...(record.input.payload.continuity.foreground??[]),...(record.input.payload.continuity.recalled??[])].map(x=>x.ref),
    stateAfter:{subject:ref(after),foreground:after.foreground,changed:after.changedStates},
    expressionChoice:record.output.continuity?.expressionChoice??null,
    choice:unavailable?{kind:'unavailable',payload:{reason:'input-snapshot-unavailable'}}:selected??{kind:'unavailable',payload:{reason:'input-snapshot-unavailable'}},
    response:response?{ref:ref(response),status:response.status,receipts:response.receipts}:null};
}
export function claimResponse({store,response,claimId,worker,requestId}) {
  return store.execute({requestId,commands:[{op:'claim_response',response,claimId,worker}]}).at(-1);
}
export function recordResponseDelivery({store,response,claimId,outcome,eventId,body,source,actor,requestId}) {
  return store.execute({requestId,commands:[{op:'record_response_delivery',response,claimId,outcome,eventId,body,source,actor}]}).at(-1);
}
export function recoverResponse({store,response,claimId,eventId,body,source,actor,requestId}) {
  return store.execute({requestId,commands:[{op:'recover_response',response,claimId,eventId,body,source,actor}]}).at(-1);
}
