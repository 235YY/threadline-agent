import {canonical,digest,ensure,uniqueRefs} from './contracts.mjs';
export const motivationId=subject=>`motivation:${subject}`;
export const affectTurnId=packet=>`affect-turn:${packet.packetId}`;
export const sourceFor=(channel,ref)=>({id:`${channel}:${digest(ref)}`,revision:1});
// Python's canonical JSON for the two source fields is identical to this fixed shape.
const sourceKey=(channel,ref)=>canonical(sourceFor(channel,ref));
export const hasApplied=(snapshot,channel,ref)=>Object.hasOwn(snapshot.sources,sourceKey(channel,ref));
const ref=x=>({id:x.id,revision:x.revision});
const finite=(v)=>{if(typeof v==='number')ensure(Number.isFinite(v),'AFFECT_NONFINITE','finite state required');else if(Array.isArray(v))v.forEach(finite);else if(v&&typeof v==='object')Object.values(v).forEach(finite);};
export function validateSnapshot(s){
 ensure(s?.format==='jingyang-affect-shadow-v1'&&s.upstream==='2132fa81b20134f469fd7adeb8e38fa20dd32071','AFFECT_STATE','fixed engine state required');
 ensure(Number.isSafeInteger(s.revision)&&s.revision>=0&&Number.isSafeInteger(s.wallAt)&&['online','offline'].includes(s.mode),'AFFECT_STATE','version/time/mode');
 ensure(s.config?.offlinePolicy==='freeze-lived-time'&&s.config?.aggregation==='weighted-counterfactual-v1','AFFECT_PROFILE','explicit experimental profile');
 ensure(s.requests&&s.sources&&s.engineState,'AFFECT_STATE','complete state required');finite(s);
 ensure(Buffer.byteLength(canonical(s))<=1024*1024,'AFFECT_STATE_LIMIT','state budget exceeded; do not silently truncate');
 for(const k of ['social','novelty','competence','recognition','fatigue','sleepiness'])ensure(typeof s.engineState.drives[k]==='number'&&s.engineState.drives[k]>=0&&s.engineState.drives[k]<=1,'AFFECT_RANGE','drive out of range');
 for(const group of ['mood','baseline'])for(const k of ['p','a','d'])ensure(typeof s.engineState[group][k]==='number'&&Math.abs(s.engineState[group][k])<=1,'AFFECT_RANGE','PAD out of range');
 ensure(!s.engineState.intents.length&&!Object.keys(s.engineState.sexuality).length&&s.engineState.drives.libido===0&&s.engineState.drives.intimacy===0,'AFFECT_DISABLED_STATE','automatic/adult states disabled');return s;
}
export function projection(s){validateSnapshot(s);const e=s.engineState;return {drives:Object.fromEntries(['social','novelty','competence','recognition','fatigue','sleepiness'].map(k=>[k,e.drives[k]])),mood:e.mood,baseline:e.baseline,
 emotions:Object.values(e.emotions).sort((a,b)=>b.i-a.i).slice(0,12).map(x=>({name:x.name,target:x.target,intensity:x.i,cause:x.cause??null})),
 meaning:'计算出的内部状态，不是事实结论、当前认可、行动命令或工具权限。'};}
export function motivationInput({store,subjectId,currentEvent=null,preview=null}){
 const subject=store.read(subjectId);if(!subject?.motivationState){ensure(!preview,'AFFECT_NOT_INITIALIZED','no host preview without stored state');return null;}
 const record=store.read(subject.motivationState.id,subject.motivationState.revision);ensure(record?.type==='motivation_state'&&record.subject===subjectId,'AFFECT_REFERENCE','own motivation state');
 let s=record.snapshot;if(preview){ensure(canonical(preview.baseRef)===canonical(ref(record))&&preview.baseHash===digest(record.snapshot),'STALE_MOTIVATION','preview base changed');s=validateSnapshot(preview.snapshot);ensure(digest(s.config)===digest(record.snapshot.config),'AFFECT_PROFILE','preview changed profile');}
 return {format:'jingyang-motivation-input-v1',ref:ref(record),asOf:s.wallAt,profileHash:digest(s.config),previewHash:digest(s),projection:projection(s),
 canAppraiseCurrent:!!currentEvent&&!hasApplied(s,'appraisal',currentEvent),
 boundary:'状态可参与统觉、认识与行动选择；不自动写C/R/Z或Impression，不修改焦点、许可或意愿。'};
}
export function normalizeAffectAppraisal(value,packet){
 if(value===null||value===undefined)return null;
 ensure(packet.payload.continuity?.motivation,'AFFECT_DISABLED','affect appraisal not enabled');
 ensure(packet.payload.current&&packet.payload.continuity.motivation.canAppraiseCurrent,'AFFECT_ALREADY_APPRAISED','no new appraisal of this source in this mode');
 ensure(value&&Object.getPrototypeOf(value)===Object.prototype&&canonical(Object.keys(value).sort())===canonical(['appraisals','source_refs']),'AFFECT_APPRAISAL_SHAPE','appraisals and source_refs required');
 const refs=uniqueRefs(value.source_refs);ensure(refs.length===1&&canonical(refs[0])===canonical(ref(packet.payload.current)),'AFFECT_SOURCE','appraisal must bind exactly to this current event');
 ensure(Array.isArray(value.appraisals)&&value.appraisals.length>=1&&value.appraisals.length<=8,'AFFECT_APPRAISAL_LIMIT','one to eight weighted appraisals');
 let sum=0;const fields=new Set(['event','summary','valence','intensity','relevance','agency','target','prospective','loss','blocked','humor','novelty','affinity','competence','fiction']);
 for(const item of value.appraisals){ensure(item&&canonical(Object.keys(item).sort())===canonical(['value','weight'])&&typeof item.weight==='number'&&item.weight>0&&item.weight<=1,'AFFECT_WEIGHT','explicit positive weight');sum+=item.weight;
  const a=item.value;ensure(a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).every(k=>fields.has(k)),'AFFECT_APPRAISAL_FIELD','unsupported appraisal field');
  ensure(['event','summary','valence','intensity','relevance','agency'].every(k=>Object.hasOwn(a,k)),'AFFECT_APPRAISAL_FIELD','required appraisal field');
  ensure(typeof a.event==='string'&&a.event.length>0&&a.event.length<=80&&typeof a.summary==='string'&&a.summary.length<=400&&['self','other','circumstance'].includes(a.agency),'AFFECT_APPRAISAL_FIELD','bounded labels and agency');
  for(const [k,lo] of [['valence',-1],['intensity',0],['relevance',0],['humor',0],['novelty',0],['affinity',-1],['competence',-1]])if(k in a)ensure(typeof a[k]==='number'&&Number.isFinite(a[k])&&a[k]>=lo&&a[k]<=1,'AFFECT_APPRAISAL_RANGE','appraisal number out of range');
  for(const k of ['prospective','loss','blocked','fiction'])ensure(!(k in a)||typeof a[k]==='boolean','AFFECT_APPRAISAL_FIELD','boolean required');
  ensure(a.target===undefined||a.target===null||typeof a.target==='string','AFFECT_TARGET','stable entity id or null');
 }ensure(Math.abs(sum-1)<1e-9,'AFFECT_WEIGHT','weights must sum to one');return JSON.parse(canonical(value));
}
export function verifyTransition(t,{record,packet,output,subjectId}){
 ensure(t&&t.packetId===packet.packetId&&canonical(t.baseRef)===canonical(ref(record))&&t.baseHash===digest(record.snapshot),'STALE_MOTIVATION','fixed input state required');
 ensure(t.subject===subjectId&&t.appraisalHash===digest(output.affectAppraisal??null),'AFFECT_BINDING','worker candidate differs from adopted appraisal');
 const s=validateSnapshot(t.snapshot);ensure(digest(s.config)===digest(record.snapshot.config)&&s.wallAt===packet.payload.continuity.motivation.asOf&&s.revision>=record.snapshot.revision,'AFFECT_BINDING','time/profile mismatch');
 ensure(t.previewHash===packet.payload.continuity.motivation.previewHash&&Array.isArray(t.receipts),'AFFECT_BINDING','preview and receipts required');return s;
}
