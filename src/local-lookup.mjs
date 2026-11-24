import {canonical,digest,ensure,text,uniqueRefs} from './contracts.mjs';
import {lookupPolicy,lookupResultId} from './local-query.mjs';

// Explicit local read only. No model client, outer loop, external effects or new encounter.
export class LocalLookupSession {
  #store;#subjectId;#policy;
  constructor({store,subjectId,policy={maxReads:4,maxHits:4}}) {
    text(subjectId,'subject id');this.#store=store;this.#subjectId=subjectId;this.#policy=lookupPolicy(policy);
  }
  execute({decision,semantic=[]}) {
    uniqueRefs([decision]);
    const old=this.#store.read(lookupResultId(decision));
    if(old?.subject===this.#subjectId&&(semantic.length||old.semanticHints?.length)){
      const round=this.#store.read(old.round.id,old.round.revision);
      ensure(round&&canonical(round.policy)===canonical(this.#policy),'LOOKUP_POLICY','cannot reset an existing lookup policy');
      return old;
    }
    return this.#store.execute({requestId:`local-lookup:${digest({subject:this.#subjectId,decision,policy:this.#policy})}`,
      commands:[{op:'local_memory_lookup',subjectId:this.#subjectId,decision,policy:this.#policy,...(semantic.length?{semantic}:{})}]}).at(-1);
  }
  readResult({result}) {
    uniqueRefs([result]);const record=this.#store.read(result.id,result.revision);
    ensure(record?.type==='lookup_result'&&record.subject===this.#subjectId,'MISSING_LOOKUP','unknown own lookup result');
    return record;
  }
}
