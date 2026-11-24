import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {memoryAudience} from './memory-access.mjs';
import {rankMemory} from './memory-reminders.mjs';
import {refKey} from './contracts.mjs';

const modelPath=directory=>resolve(directory).replaceAll('\\','/');

export function localE5Encoder({runtimeModule,modelDirectory}){
  let load=null;
  const path=modelPath(modelDirectory);
  return async (texts,kind)=>{
    load??=(async()=>{
      const {env,pipeline}=await import(pathToFileURL(resolve(runtimeModule)));
      env.allowRemoteModels=false;
      return pipeline('feature-extraction',path,{device:'cpu',dtype:'int8',local_files_only:true});
    })();
    const extract=await load;
    const answer=await extract(texts.map(text=>(kind==='query'?'query: ':'passage: ')+text),
      {pooling:'mean',normalize:true});
    return answer.tolist();
  };
}

export function localMemoryReranker({runtimeModule,rerankerDirectory}){
  let load=null;
  const path=modelPath(rerankerDirectory);
  return async (query,passages)=>{
    load??=(async()=>{
      const {env,AutoTokenizer,AutoModelForSequenceClassification}=await import(pathToFileURL(resolve(runtimeModule)));
      env.allowRemoteModels=false;
      const options={device:'cpu',dtype:'q8',local_files_only:true};
      const tokenizer=await AutoTokenizer.from_pretrained(path,options);
      const model=await AutoModelForSequenceClassification.from_pretrained(path,options);
      return {tokenizer,model};
    })();
    const {tokenizer,model}=await load;
    const encoded=tokenizer(passages.map(()=>query),{text_pair:passages,padding:true,truncation:true,max_length:384});
    const {logits}=await model(encoded);
    return Array.from(logits.data);
  };
}

function unit(values){
  if(!Array.isArray(values)||!values.length||values.length>2048||values.some(x=>!Number.isFinite(x)))return null;
  const length=Math.sqrt(values.reduce((sum,x)=>sum+x*x,0));
  return length&&Number.isFinite(length)?Float32Array.from(values,x=>x/length):null;
}
function dot(a,b){
  if(a.length!==b.length)return 0;
  let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;
}

// Local, optional, and derived. A slow/missing encoder falls back to lexical and
// recorded relations. Only one local encoder operation can be outstanding.
export class SemanticMemory {
  #store=null;#subject=null;#position=0;#vectors=new Map();#inFlight=null;#failed=false;#rerankerFailed=false;#timer=null;#stopped=false;
  constructor({encode,rerank=null,deadlineMs=rerank?750:300}){
    if(typeof encode!=='function')throw new TypeError('local embedding encoder required');
    if(rerank!==null&&typeof rerank!=='function')throw new TypeError('local memory reranker must be callable');
    if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>5000)throw new TypeError('invalid embedding deadline');
    this.encode=encode;this.rerank=rerank;this.deadlineMs=deadlineMs;
  }
  get status(){return {indexed:this.#vectors.size,failed:this.#failed,rerankerFailed:this.#rerankerFailed,busy:this.#inFlight!==null};}
  warm(context){
    if(this.#failed||this.#stopped||this.#timer)return;
    this.#timer=setTimeout(async()=>{
      this.#timer=null;
      if(this.#inFlight){this.warm(context);return;}
      try{if(await this.indexBatch(context)===24)this.warm(context);}
      catch{this.#failed=true;}
    },100);
    this.#timer.unref?.();
  }
  stop(){this.#stopped=true;clearTimeout(this.#timer);this.#timer=null;}
  #run(work){
    const task=Promise.resolve().then(work).catch(()=>{this.#failed=true;return [];})
      .finally(()=>{this.#inFlight=null;});
    this.#inFlight=task;return task;
  }
  async indexBatch({store,subjectId}){
    if(this.#failed||this.#inFlight||this.#stopped)return 0;
    this.#store??=store;this.#subject??=subjectId;
    if(this.#store!==store||this.#subject!==subjectId)throw new Error('embedding cache is tied to one library');
    const batch=store.memoryEmbeddingChanges({subjectId,after:this.#position,limit:24});
    if(!batch.length)return 0;
    return this.#run(async()=>{
      const live=batch.filter(x=>x.body),encoded=live.length?await this.encode(live.map(x=>x.body),'passage'):[];
      if(encoded.length!==live.length)throw new Error('embedding batch shape');
      let i=0;
      for(const row of batch){
        if(!row.body){this.#vectors.delete(row.id);continue;}
        const vector=unit(encoded[i++]);
        if(!vector)throw new Error('invalid embedding vector');
        this.#vectors.set(row.id,{ref:{id:row.id,revision:row.revision},vector});
      }
      this.#position=batch.at(-1).position;
      return batch.length;
    });
  }
  async find({store,subjectId,event,now,text,query=null,acceptRecord=()=>true}){
    if(this.#failed||this.#inFlight||this.#stopped)return [];
    if(!this.#vectors.size){this.warm({store,subjectId});return [];}
    if(store!==this.#store||subjectId!==this.#subject)return [];
    const allowed=memoryAudience({store,event,now,subjectId});
    let best=[];
    const input=String(text).slice(0,512);
    const task=this.#run(async()=>{
      const vectorQuery=unit((await this.encode([input],'query'))[0]);
      if(!vectorQuery)throw new Error('invalid query vector');
      if(this.#stopped)return [];
      const top=[];
      for(const {ref,vector} of this.#vectors.values()){
        const similarity=dot(vectorQuery,vector);
        if(similarity<0.76||top.length>=24&&similarity<top.at(-1).similarity)continue;
        const record=store.read(ref.id,ref.revision);
        if(!allowed(record)||!acceptRecord(record))continue;
        top.push({ref,similarity});top.sort((a,b)=>b.similarity-a.similarity||a.ref.id.localeCompare(b.ref.id));
        if(top.length>24)top.pop();
      }
      best=top;
      if(!this.rerank||this.#rerankerFailed)return best;
      const {rerankPool}=store.view(()=>rankMemory({store,subjectId,event,now,query,semantic:top,prepareRerank:true,acceptRecord}));
      if(!rerankPool.length)return best;
      try{
        const scores=await this.rerank(input,rerankPool.map(row=>row.body));
        if(!Array.isArray(scores)||scores.length!==rerankPool.length||scores.some(x=>!Number.isFinite(x)))throw new Error('invalid reranking scores');
        const hints=new Map(top.map(row=>[refKey(row.ref),row]));
        const scored=rerankPool.map(({id,revision},i)=>{
          const ref={id,revision},key=refKey(ref),similarity=hints.get(key)?.similarity??0;
          hints.delete(key);
          return {ref,similarity,relevance:scores[i]};
        });
        return [...scored,...hints.values()].slice(0,24);
      }catch{
        this.#rerankerFailed=true;
        return best;
      }
    });
    let timer;
    const result=await Promise.race([task,new Promise(resolve=>{timer=setTimeout(()=>resolve(best),this.deadlineMs);})]);
    clearTimeout(timer);
    this.warm({store,subjectId});
    return result;
  }
}
