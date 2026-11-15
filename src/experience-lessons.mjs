// Optional note adapter, not a learner or a planner. Meaning and applicability belong to the subject.
import {canonical,digest,ensure,refKey,text,uniqueRefs} from './contracts.mjs';

export const LESSON_FORMAT='experience-lesson-v1';
const pin=r=>({id:r.id,revision:r.revision});
const newLessonId=(subject,decisionId,index)=>`lesson:${subject}:${digest({decisionId,index})}`;
const keys=(x,allowed)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>allowed.includes(k)),
  'LESSON_SHAPE','unsupported experience fields');
const short=(x,name,max)=>{text(x,name);ensure([...x].length<=max,'LESSON_LIMIT',`${name} too long`);return x;};
function owned(record,subject){
  if(record?.type!=='note'||record.kind!=='skill'||!record.scope.people.includes(subject))return null;
  try{const d=JSON.parse(record.body);return d.format===LESSON_FORMAT&&d.subject===subject?d:null;}catch{return null;}
}

// A bounded RECENT directory, not a relevance ranking or full evidence delivery.
export function experienceLearningInput({store,subjectId}){
  const subject=store.read(subjectId);
  ensure(subject?.type==='subject','LESSON_SUBJECT','existing subject required');
  const entries=[...store.all('note')].flatMap(n=>{const d=owned(n,subjectId);return d?[{record:n,data:d}]:[];})
    .sort((a,b)=>b.record.recordedAt-a.record.recordedAt||a.record.id.localeCompare(b.record.id));
  const last=subject.lastDecision?store.read(subject.lastDecision.id,subject.lastDecision.revision):null;
  const submission=last&&Object.hasOwn(last.output,'lessons')?{decision:pin(last),
    items:Array.isArray(last.output.lessons)?last.output.lessons.slice(0,2).map((x,index)=>{
      const target=x?.ref;
      if(target!=null&&(!target||Object.getPrototypeOf(target)!==Object.prototype||typeof target.id!=='string'||!target.id.trim()||!Number.isSafeInteger(target.revision)||target.revision<1||!Number.isSafeInteger(target.revision+1)))
        return {proposal:index,status:'not-saved'};
      const id=target?.id??newLessonId(subjectId,last.id,index),revision=target?target.revision+1:1;
      const r=store.read(id,revision),d=owned(r,subjectId);
      const saved=d?.formedBy?.decision?.id===last.id&&d.formedBy.proposal===index;
      return {proposal:index,status:saved?'saved':'not-saved',...(saved?{ref:pin(r)}:{})};
    }):[],listAccepted:Array.isArray(last.output.lessons)&&last.output.lessons.length<=2}:null;
  return {enabled:true,format:LESSON_FORMAT,total:entries.length,hasMore:entries.length>3,lastSubmission:submission,
    directory:entries.slice(0,3).map(({record:r,data:d})=>({ref:pin(r),lesson:String(d.lesson).slice(0,200),conditions:String(d.conditions).slice(0,200),
      scope:String(d.scope).slice(0,200),status:d.status,representation:'recent-pointer-and-excerpt-not-full-evidence-not-applicability'})),
    meaning:'historical-subjective-lessons-not-current-facts-or-instructions; status-is-subject-assessment-not-host-verification; use-existing-lookup-to-read; no-required-learning-or-use'};
}

// Only full materials/current events in this exact packet authorize NEW citations.
// Earlier sources survive via note.evidence and previous; their bodies are not claimed delivered again.
export function stageExperienceLessons({store,packet,output,decisionId}){
  if(!Object.hasOwn(output,'lessons'))return [];
  ensure(packet.payload.experienceLearning?.enabled===true,'LESSON_DISABLED','experience learning was not enabled');
  if(!Array.isArray(output.lessons)||output.lessons.length>2){
    store.recordDiagnostic({stage:'experience.lesson-rejected',status:'rejected',context:{packetId:packet.packetId,decisionId,subjectId:packet.payload.continuity?.subject?.id},data:{code:'LESSON_LIMIT',meaning:'optional learning rejected; decision may continue; raw output retained in decision attempt'}});
    return [];
  }
  const subject=packet.payload.continuity?.subject?.id;
  ensure(subject&&store.read(subject)?.type==='subject','LESSON_SUBJECT','own continuity subject required');
  const delivered=new Map((packet.payload.materials??[]).map(m=>[refKey(m.ref),m.record]));
  if(packet.payload.current)delivered.set(refKey(packet.payload.current),packet.payload.current);
  const ids=new Set();
  const commands=output.lessons.flatMap((x,index)=>{try{
    keys(x,['ref','lesson','conditions','scope','status','evidence','counterexamples','unknowns','prediction','explanation','confidence']);
    const prior=x.ref==null?null:store.read(uniqueRefs([x.ref])[0].id,x.ref.revision);
    if(x.ref!=null){
      ensure(prior&&owned(prior,subject),'LESSON_OWNER','read an existing own experience note before revising');
      ensure(delivered.has(refKey(prior)),'LESSON_UNREAD','directory excerpts do not authorize revision');
      ensure(store.read(prior.id).revision===prior.revision,'LESSON_STALE','read the current lesson before revising');
    }
    const sources=(items=[])=>{
      ensure(Array.isArray(items)&&items.length<=8,'LESSON_LIMIT','bounded experience sources required');
      return items.map(item=>{
        keys(item,['ref','nature']);uniqueRefs([item.ref]);const r=delivered.get(refKey(item.ref));
        ensure(r&&['event','note'].includes(r.type),'LESSON_UNDELIVERED_SOURCE','read the exact source body before citing it');
        ensure(['observation','report','receipt','interpretation'].includes(item.nature),'LESSON_SOURCE_NATURE','declare source nature');
        if(item.nature==='receipt')ensure(r.type==='event'&&r.origin==='tool_receipt','LESSON_RECEIPT','a proposal or report is not an execution receipt');
        if(item.nature==='observation')ensure(r.type==='event'&&r.origin==='observed','LESSON_OBSERVATION','observed event required');
        if(item.nature==='report')ensure(r.type==='event'&&r.origin==='reported','LESSON_REPORT','reported event required');
        return {ref:pin(r),nature:item.nature};
      });
    };
    const evidence=sources(x.evidence),counterexamples=sources(x.counterexamples);
    // Reinterpretations may cite an existing lesson's original roots without reloading every old body.
    const lineage=uniqueRefs([...(prior?.evidence??[]),...evidence.map(e=>e.ref),...counterexamples.map(e=>e.ref)]);
    ensure(lineage.length>0&&lineage.length<=32,'LESSON_SOURCE','retain bounded, explicit experience provenance');
    ensure(lineage.some(r=>{const e=store.read(r.id,r.revision);return e?.type==='event'&&['observed','reported','tool_receipt'].includes(e.origin);})||prior,
      'LESSON_SOURCE','a new lesson needs an actual encounter or report, not just another generalization or imagination');
    const status=x.status??'tentative',confidence=x.confidence??'tentative';
    ensure(['tentative','supported','contested','retired'].includes(status),'LESSON_STATUS','invalid subjective lesson status');
    ensure(['tentative','uncertain','confident'].includes(confidence),'LESSON_CONFIDENCE','subjective confidence required');
    const unknowns=x.unknowns??[];ensure(Array.isArray(unknowns)&&unknowns.length<=6,'LESSON_LIMIT','bounded unknowns');
    unknowns.forEach(u=>short(u,'unverified scope',240));
    const data={format:LESSON_FORMAT,subject,lesson:short(x.lesson,'lesson',800),conditions:short(x.conditions,'conditions',500),
      scope:short(x.scope,'scope',500),status,evidence,counterexamples,unknowns,
      prediction:x.prediction==null?null:short(x.prediction,'prediction',500),explanation:x.explanation==null?null:short(x.explanation,'explanation',600),previous:prior?pin(prior):null,
      formedBy:{decision:{id:decisionId,revision:1},proposal:index}};
    const id=prior?.id??newLessonId(subject,decisionId,index);
    ensure(!ids.has(id),'LESSON_DUPLICATE','one revision per lesson per decision');ids.add(id);
    ensure(!lineage.some(r=>r.id===id),'LESSON_SELF_SOURCE','use previous version pointer, not self evidence');
    const command={op:'write_note',id,expectedRevision:prior?.revision??0,kind:'skill',body:canonical(data),change:'reinterpretation',confidence,
      status:status==='retired'?'historical':'current',evidence:lineage,
      scope:{scenes:[],people:[subject],validFrom:null,validUntil:null}};
    return [command];
  }catch(error){
    // Do not swallow persistence/IO faults. A malformed optional lesson alone need not lose the decision.
    if(!error.code?.startsWith('LESSON_')&&!['INVALID_INPUT','INVALID_REFERENCE','INVALID_REVISION'].includes(error.code))throw error;
    store.recordDiagnostic({stage:'experience.lesson-rejected',status:'rejected',context:{packetId:packet.packetId,decisionId,subjectId:subject},data:{index,code:error.code,meaning:'lesson not saved; raw proposal retained in decision attempt'}});
    return [];
  }
  });
  return commands;
}
