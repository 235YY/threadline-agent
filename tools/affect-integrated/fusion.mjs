import {canonical,digest,ensure,uniqueRefs} from '../../src/contracts.mjs';
import {normalizeApperception,apperceptionSources} from '../../src/cognition.mjs';
import {normalizeAffectAppraisal,projection} from '../../src/affect-contract.mjs';

const ref=x=>({id:x.id,revision:x.revision});
const key=r=>canonical(ref(r));
const bounded=(s,max)=>typeof s==='string'&&s.length>0&&s.length<=max;
export const meaningId=(subject,sources)=>`extension:${subject}:affect:meaning:${digest([...sources].sort((a,b)=>key(a).localeCompare(key(b))))}`;
const meanings=(store,subject)=>[...store.all('extension_record')].filter(r=>r.owner===subject&&r.theory==='affect'&&r.stateType==='event-meaning');

// These are packet-local source handles, not new database facts or memories.
export function fusionContext({store,subjectId,motivation,currentEvent,materials=[],stateRefs=[]}){
 currentEvent=currentEvent?store.read(currentEvent.id,currentEvent.revision):null;
 const subject=store.read(subjectId);
 stateRefs=uniqueRefs([...stateRefs,...(subject?.foreground??[])]);
 const focus=new Set([currentEvent?.sender?.entityId,...(currentEvent?.about??[]).map(x=>x.id),...stateRefs.map(x=>x.id)].filter(Boolean));
 const delivered=[currentEvent,...materials.map(m=>store.read(m.ref.id,m.ref.revision)),...stateRefs.map(r=>store.read(r.id,r.revision))].filter(Boolean);
 for(const r of delivered){for(const x of r.about??[])focus.add(x.id);if(r.sender?.entityId)focus.add(r.sender.entityId);}
 const all=Object.values(motivation.projection.emotions??[]);
 // Access the complete state via caller's projection; intensity only breaks relevance ties.
 const sorted=[...all].sort((a,b)=>Number(focus.has(b.target))-Number(focus.has(a.target))||b.intensity-a.intensity||canonical(a).localeCompare(canonical(b)));
 const selected=sorted.slice(0,12);
 const context={...motivation,projection:{...motivation.projection,emotions:selected},selection:{focusRefs:[...focus].sort(),total:all.length,omitted:Math.max(0,all.length-selected.length),method:'target-then-intensity',recovery:'host-session.readEmotions; not a granted model tool'},
  fusion:{schema:'affect.appraisal.v2',modes:['encounter','recall','reappraisal'],optional:true}};
 const source={ref:{id:'internal:affect:'+digest(context),revision:1},kind:'computed-internal'};
 context.projectionRef=source.ref;
 // A path binds the source to the sealed packet without duplicating its token-heavy body.
 source.value={baseRef:motivation.ref,asOf:motivation.asOf,profileHash:motivation.profileHash,previewHash:motivation.previewHash,projectionPath:'continuity.motivation.projection'};
 const history=meanings(store,subjectId).sort((a,b)=>Number(b.value.sourceRefs?.some(r=>delivered.some(d=>d.id===r.id)))-Number(a.value.sourceRefs?.some(r=>delivered.some(d=>d.id===r.id)))||b.recordedAt-a.recordedAt||a.id.localeCompare(b.id)).slice(0,8);
 return {motivation:context,internalSources:[source,...history.map(r=>({ref:ref(r),kind:'interpretation-history',value:r.value}))]};
}

export function completeEmotionProjection(snapshot){
 const p=projection(snapshot);
 return {...p,emotions:Object.values(snapshot.engineState.emotions).map(x=>({name:x.name,target:x.target,intensity:x.i,cause:x.cause??null}))};
}

// Narrow schema for an evaluation tied to the PUBLIC apperception result, never hidden reasoning.
export function normalizeFusionAppraisal(value,{packet,output,store,subjectId}){
 if(value==null)return null;
 ensure(value.schema_version==='affect.appraisal.v2','AFFECT_FUSION_SCHEMA','fusion evaluation requires v2');
 const allowedKeys=['schema_version','mode','source_refs','previous','reason','concern_refs','attribution_refs','appraisals'];
 ensure(Object.keys(value).every(k=>allowedKeys.includes(k)),'AFFECT_FUSION_SCHEMA','unknown evaluation field');
 ensure(['encounter','recall','reappraisal'].includes(value.mode),'AFFECT_MODE','explicit cognitive mode');
 ensure(bounded(value.reason,400),'AFFECT_REASON','bounded change/activity reason required');
 ensure(packet.payload.apperceptionV1?.enabled===true&&output.apperception,'AFFECT_INTERPRETATION','public interpretation required when evaluating affect');
 const interpretation=normalizeApperception(output.apperception,packet);
 const allowed=apperceptionSources(packet);
 const sources=uniqueRefs(value.source_refs??[]).sort((a,b)=>key(a).localeCompare(key(b)));
 ensure(sources.length>0&&sources.length<=8,'AFFECT_SOURCE','one to eight delivered experiences');
 for(const r of sources){
  ensure(allowed.has(`${r.id}@${r.revision}`),'UNDELIVERED_REFERENCE','experience was not delivered');
  ensure(store.read(r.id,r.revision)?.type==='event'&&store.subjectObservation(subjectId,r.id),'AFFECT_SOURCE','own admitted experience required');
 }
 const metadata={};
 for(const name of ['concern_refs','attribution_refs']){
  const refs=uniqueRefs(value[name]??[]);ensure(refs.length<=8,'AFFECT_SOURCE','bounded meaning links');
  for(const r of refs){ensure(allowed.has(`${r.id}@${r.revision}`),'UNDELIVERED_REFERENCE','meaning link not delivered');
   const record=store.read(r.id,r.revision);ensure(record&&(!record.subject||record.subject===subjectId),'AFFECT_SOURCE','own semantic source required');
   if(name==='concern_refs')ensure(record.type==='personal_state'&&(record.kind==='concern'||record.mind?.role==='concern'),'AFFECT_CONCERN','concern link must refer to an existing concern');}
  metadata[name]=refs;
 }
 let base={source_refs:sources,appraisals:value.appraisals};
 if(value.mode==='encounter'){
  base=normalizeAffectAppraisal(base,packet);
 }else{
  // Reuse range/weight validation without relaxing the encounter validator itself.
  ensure(value.appraisals?.length,'AFFECT_APPRAISAL_LIMIT','evaluation required');
  base=normalizeAffectAppraisal({source_refs:[sources[0]],appraisals:value.appraisals},{payload:{current:sources[0],continuity:{motivation:{canAppraiseCurrent:true}}}});
  base.source_refs=sources;
 }
 const interpretationRefs=new Set(interpretation.activated_cells.flatMap(c=>c.source_refs.map(key)));
 for(const r of sources)ensure(interpretationRefs.has(key(r)),'AFFECT_INTERPRETATION','experience must occur in the shared interpretation sources');
 const id=meaningId(subjectId,sources),old=store.read(id),previous=value.previous??null;
 if(old)ensure(old.type==='extension_record'&&old.owner===subjectId&&old.theory==='affect'&&old.stateType==='event-meaning'&&old.schemaVersion==='affect-meaning-v1'&&canonical(old.value.sourceRefs)===canonical(sources),'AFFECT_HISTORY','incompatible meaning history');
 if(previous){uniqueRefs([previous]);ensure(old&&key(previous)===key(old)&&allowed.has(`${previous.id}@${previous.revision}`),'AFFECT_PREVIOUS','current delivered interpretation required');}
 if(value.mode==='reappraisal')ensure(previous,'AFFECT_PREVIOUS','reappraisal must identify the prior interpretation');
 const semanticHash=digest({text:interpretation.integrated_understanding,cells:interpretation.activated_cells.map(({source_refs,...c})=>c),appraisals:base.appraisals,...metadata});
 if(value.mode==='reappraisal')ensure(old.value.semanticHash!==semanticHash,'AFFECT_NO_CHANGE','unchanged interpretation is not a new reappraisal');
 return {...base,...metadata,schema_version:value.schema_version,mode:value.mode,reason:value.reason,previous,
  interpretation,semanticHash,historyId:id,expectedRevision:old?.revision??0};
}

export function meaningWrite(appraisal,{subjectId,packet,decisionId}){
 if(!appraisal)return null;
 return {id:appraisal.historyId,owner:subjectId,theory:'affect',stateType:'event-meaning',schemaVersion:'affect-meaning-v1',expectedRevision:appraisal.expectedRevision,
  value:{mode:appraisal.mode,reason:appraisal.reason,sourceRefs:appraisal.source_refs,previous:appraisal.previous,concernRefs:appraisal.concern_refs,attributionRefs:appraisal.attribution_refs,
   interpretation:appraisal.interpretation,semanticHash:appraisal.semanticHash,appraisals:appraisal.appraisals,packetId:packet.packetId,
   projectionRef:packet.payload.continuity.motivation.projectionRef,decision:{id:decisionId,revision:1},asOf:packet.payload.continuity.motivation.asOf,
   meaning:'evaluation-history-not-new-independent-evidence-or-automatic-endorsement'}};
}
