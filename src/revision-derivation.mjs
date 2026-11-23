// Host-derived optimistic-concurrency revisions for model proposals.
//
// Why: real model runs failed whole turns on bookkeeping, not on meaning (e.g. a
// Process revision copied into a personal_state change). The revision a proposal
// is based on is already fixed by what this packet delivered, so the host can
// supply it instead of asking the model to transcribe it.
//
// What this does NOT do:
// - It never relaxes a check. A derived revision is the delivered one; if the
//   record changed after delivery the store still rejects (STALE_*/ *_CONFLICT).
// - It never fills a value the model did provide. Explicit revisions stay strict.
// - It never decides object identity. A Process id in continuity.changes or an
//   existing Intent id is left untouched so the store reports the precise type error.
// - It never derives against a frame other than the delivered one.
import {attentionId} from './attention.mjs';

const missing=(o)=>o&&typeof o==='object'&&!Array.isArray(o)&&(!Object.hasOwn(o,'expectedRevision')||o.expectedRevision===null);

export function deliveredStateRefs(continuity){
  const c=continuity??{};
  return [...(c.foreground??[]),...(c.recalled??[]),...(c.shortTerm?.items??[]),
    ...(c.subjectiveMemory?.recent?.items??[]),...(c.subjectiveMemory?.compressed?.items??[]),
    ...(c.subjectiveMemory?.maintenance?.olderRecent??[])].map(x=>x?.ref).filter(r=>r&&typeof r.id==='string');
}

export function deriveRevisions({store,packet,value}){
  const diagnostics=[],c=value?.continuity;
  if(!c||typeof c!=='object'||Array.isArray(c))return diagnostics;
  const continuity=packet.payload?.continuity,subjectId=continuity?.subject?.id;
  const deliveredFrame=continuity?.attention?.frame??null;
  const stored=subjectId&&deliveredFrame?store.read(attentionId(subjectId)):null;
  // Only derive against the exact frame this packet delivered.
  const frame=stored&&stored.revision===deliveredFrame.revision?stored:null;
  const processIds=new Set((frame?.processes??[]).map(p=>p.id));
  const fill=(target,path,revision,basis)=>{target.expectedRevision=revision;diagnostics.push({path:path+'.expectedRevision',code:'EXPECTED_REVISION_DERIVED',value:revision,basis});};

  if(Array.isArray(c.changes)){
    const delivered=deliveredStateRefs(continuity);
    for(const [i,change] of c.changes.entries()){
      if(!missing(change)||typeof change.id!=='string')continue;
      if(processIds.has(change.id)||change.id.startsWith('intent:')&&store.read(change.id))continue;
      const seen=delivered.filter(r=>r.id===change.id).map(r=>r.revision).filter(Number.isSafeInteger);
      if(seen.length){fill(change,`continuity.changes[${i}]`,Math.max(...seen),'delivered-state');continue;}
      const current=store.read(change.id);
      // Existing but undelivered: use its current revision so the store reports
      // the real problem (UNREAD_STATE / ID_COLLISION) instead of a revision mismatch.
      fill(change,`continuity.changes[${i}]`,current?current.revision:0,current?'existing-undelivered':'new-state');
    }
  }

  const a=c.attention;
  if(frame&&a&&typeof a==='object'&&!Array.isArray(a)){
    for(const key of ['processes','relations','questions']){
      if(!Array.isArray(a[key]))continue;
      for(const [i,item] of a[key].entries()){
        if(!missing(item)||typeof item.id!=='string')continue;
        const old=(frame[key]??[]).find(x=>x.id===item.id);
        fill(item,`continuity.attention.${key}[${i}]`,old?old.revision:0,old?'delivered-frame':{processes:'new-process',relations:'new-relation',questions:'new-question'}[key]);
      }
    }
  }
  return diagnostics;
}
