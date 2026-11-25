import {refKey} from './contracts.mjs';
import {isGroupScene} from './social-projection.mjs';
import {recordNode} from './knowledge-graph.mjs';
import {memoryAudience,memoryPersonKeys} from './memory-access.mjs';
import {memoryTokens} from './memory-index.mjs';
import {fuseConsultationRanks} from './consultation.mjs';
import {attentionId} from './attention.mjs';
import {eventProcessId,threadUnits} from './task-threads.mjs';
import {CORE_PINBOARD_ID,readPinboard} from './memory-gating.mjs';

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const normalize=text=>String(text??'').normalize('NFKC').toLowerCase();
const chars=text=>[...text].length;
const ignored=new Set(('你好 您好 早安 晚安 早上 中午 下午 晚上 嗨 哈哈 谢谢 在吗 今天 昨天 最近 刚才 上次 之前 以前 那个 这个 那只 这只 那件事 这件事 一下 一点 事情 什么 怎么 如何 哪个 我们 你们 他们 喜欢 记得 想起 帮忙 继续 接着 后来 进展 进度 结果 现在 感觉 有点 真的 可以 能不能 好像 觉得 有关 相关 帮我 我把 看看 了解 查询 查找 核对 资料 调查 项目 工作 计划 方案 内容 一起 好累 累了 问题 今天好累 很开心 很高兴 开心 高兴 今天好开心 辛苦 辛苦了 明天 好玩 没事 好呀 好吗 聊到 一张 一会 哪里 过得 ok hey hello hi good morning evening night thanks yes sure').split(' '));
const singleConnectors=new Set('我你他她它在的了吧呀吗呢啊哦是和与给把让上下来去看想说查找发现有要会能再很也都只还刚真挺这那一'.split(''));
const backReference=/(?:上次|之前|刚才|以前)(?:的|说的|聊的|提的|说过的)?(?:那个|那次|那件|那项|那条|怎么样|后来|呢)|(?:那件事|那个项目|那后来|后来呢|接着上次)/u;
const recallRequest=/还记得|记不记得|想得起来|上次|之前|以前|那个项目|再发|帮我找|查一下|找一下/u;
const isHan=term=>/^\p{Script=Han}+$/u.test(term);
const noteRef=({id,revision})=>({id,revision});

function termsIn(text){
  const body=normalize(text).slice(0,480),terms=[];
  for(const {0:identifier} of body.matchAll(/\b[a-z][a-z\d]*(?:[-_.][a-z\d]+)+\b/gu))terms.push(identifier);
  let compound='';
  for(const {isWordLike,segment} of segmenter.segment(body)){
    if(isWordLike&&segment.length===1&&isHan(segment)&&!singleConnectors.has(segment)){
      compound+=segment;
      continue;
    }
    if(compound)terms.push(compound);
    compound='';
    if(isWordLike)terms.push(segment);
  }
  if(compound)terms.push(compound);
  return [...new Set(terms.filter(term=>chars(term)>=2&&chars(term)<=32&&!/^\d+$/u.test(term)&&!ignored.has(term)))];
}

function strong(term){
  return isHan(term)?chars(term)>=4:/[a-z][0-9]|[0-9][a-z]|[_-]/u.test(term)||chars(term)>=5;
}
export function shouldTrySemanticRecall(text){
  const terms=termsIn(text);
  return recallRequest.test(text)||backReference.test(text)||terms.length>=2||terms.some(strong);
}

function previousTopic(store,subjectId,event,people){
  const at=event.occurredAt??event.recordedAt;
  if(!Number.isSafeInteger(at))return [];
  for(const item of store.newestInScene({type:'event',scene:event.scene,limit:12,since:at-20*60_000})){
    const earlier=item.occurredAt??item.recordedAt;
    if(item.id===event.id||earlier>=at||!['observed','reported'].includes(item.origin)||!store.subjectObservation(subjectId,item.id))continue;
    if(isGroupScene(event.scene)&&!memoryPersonKeys(item).some(person=>people.includes(person)))continue;
    const terms=termsIn(item.body);
    if(terms.length>=2||terms.some(strong))return {terms,ref:noteRef(item)};
  }
  return {terms:[],ref:null};
}

const overlaps=(first,second)=>first.some(term=>term===second||term.includes(second)||second.includes(term));
function matchesIn(note,terms){
  const body=normalize(note.body),words=new Set(termsIn(note.body));
  return terms.filter(term=>isHan(term)||/[^\p{L}\p{N}]/u.test(term)?body.includes(term):words.has(term));
}

function processCandidates({store,subjectId,event,text,terms,previous,accept}){
  const frame=store.read(attentionId(subjectId));
  if(!frame?.processes?.length)return [];
  const focused=new Set((frame.focus?.selection??[]).filter(x=>x.kind==='process').map(x=>x.id));
  const matches=frame.processes.filter(p=>{
    const title=normalize(p.label);
    const explicit=store.read(eventProcessId(subjectId,noteRef(event),p.id))?.value?.status==='active'
      ||previous&&store.read(eventProcessId(subjectId,previous,p.id))?.value?.status==='active';
    const termsMatch=terms.filter(term=>title.includes(term));
    return explicit||title.length>=2&&normalize(text).includes(title)||termsMatch.length>=2
      ||backReference.test(text)&&focused.size===1&&focused.has(p.id);
  }).slice(0,2);
  const refs=new Map();
  for(const p of matches){
    const history=threadUnits({store,threadId:p.id,subjectId,limit:12});
    const candidates=[...history.units.toReversed().flatMap(u=>[u.latestResult?.ref,u.ref].filter(Boolean)),...(p.basis??[])];
    for(const r of candidates)if(accept(r))refs.set(refKey(r),r);
  }
  return [...refs.values()].slice(0,16);
}

export function rankMemory({store,subjectId,event,now,query=null,semantic=[],prepareRerank=false,acceptRecord=()=>true}){
  const text=query?.join(' ')??event.body,explicitRead=query!==null;
  const people=memoryPersonKeys(event),canDeliver=memoryAudience({store,subjectId,event,now});
  const current=explicitRead?query.map(normalize):termsIn(text);
  const previous=!explicitRead&&backReference.test(text)&&current.length<=1?previousTopic(store,subjectId,event,people):{terms:[],ref:null};
  const borrowed=previous.terms;
  const quoted=[...normalize(text).matchAll(/[“「《"]([^”」》"]{2,24})[”」》"]/gu)]
    .map(match=>match[1].trim()).filter(term=>termsIn(term).length).slice(0,2);
  const terms=[...new Set([...quoted,...current,...borrowed])].slice(0,8),asked=recallRequest.test(text);
  const canSearch=explicitRead||terms.length>=2||terms.some(strong)||quoted.length>0||asked;
  if(!canSearch&&!backReference.test(text))return {ranked:[],canDeliver,rerankPool:[]};

  const byKey=new Map();
  const accept=ref=>{
    const key=refKey(ref);
    if(byKey.has(key))return Boolean(byKey.get(key));
    const record=store.read(ref.id,ref.revision);
    if(!record||!canDeliver(record)||!acceptRecord(record)||record.id===event.id||record.id===CORE_PINBOARD_ID
      ||record.id.startsWith('rhythm:')||record.id.startsWith('note:journal:')||record.id==='note:slow-watermark'||typeof record.body!=='string'){
      byKey.set(key,null);return false;
    }
    byKey.set(key,record);return true;
  };
  const context=processCandidates({store,subjectId,event,text,terms,previous:previous.ref,accept});
  const contextKeys=new Set(context.map(refKey));
  const recentAlreadyVisible=record=>record.type==='event'&&record.scene===event.scene
    &&now-(record.occurredAt??record.recordedAt)<5*60_000;
  const lexical=terms.length?store.memoryLexicalRefs({terms,accept:ref=>{
    if(!accept(ref))return false;
    return explicitRead||!recentAlreadyVisible(byKey.get(refKey(ref)));
  },limit:explicitRead?256:64}):[];
  const candidates=lexical.map(ref=>({ref,note:byKey.get(refKey(ref)),matches:matchesIn(byKey.get(refKey(ref)),terms)}));
  const frequency=new Map(terms.map(term=>[term,candidates.filter(c=>c.matches.includes(term)).length]));
  const lexicalByEvidence=candidates.flatMap(({ref,note,matches})=>{
    const independent=[];
    for(const term of [...matches].sort((a,b)=>chars(b)-chars(a)))if(!overlaps(independent,term))independent.push(term);
    const anchor=note.anchor?.kind==='entity'&&people.includes(note.anchor.id);
    const distinctive=independent.some(term=>current.includes(term)&&frequency.get(term)<=2);
    const enough=independent.some(term=>quoted.includes(term)||strong(term))||independent.length>=2
      ||asked&&(anchor||distinctive);
    // BM25 can propose a part-word match. Automatic recall still needs enough
    // independent evidence or another lane to put it in front of the subject.
    if(!explicitRead&&(!independent.length||!enough))return [];
    const score=independent.reduce((sum,term)=>sum+(borrowed.includes(term)&&!current.includes(term)?1:2)
      +Math.min(2,Math.log((candidates.length+1)/(frequency.get(term)+1)))+(quoted.includes(term)?3:strong(term)?1:0),0);
    return [{ref,score}];
  }).sort((a,b)=>b.score-a.score);

  const lexicalKeys=new Set(lexicalByEvidence.map(x=>refKey(x.ref)));
  const dense=semantic.filter(v=>v.similarity>=0.76&&accept(v.ref))
    .sort((a,b)=>b.similarity-a.similarity||a.ref.id.localeCompare(b.ref.id)).slice(0,24);
  if(prepareRerank){
    const shortlist=new Map();
    const hits=[context.slice(0,2),lexicalByEvidence.slice(0,6).map(x=>x.ref),dense.slice(0,6).map(x=>x.ref)];
    for(let i=0;i<6&&shortlist.size<8;i++)for(const lane of hits){
      const ref=lane[i];
      if(ref&&shortlist.size<8)shortlist.set(refKey(ref),byKey.get(refKey(ref)));
    }
    return {rerankPool:[...shortlist.values()]};
  }
  const exactTerms=[...quoted,...current.filter(term=>/[a-z][\w.-]*[-_.][a-z\d]|[a-z]\d|\d[a-z]/u.test(term))];
  const exactKeys=new Set(lexicalByEvidence.filter(({ref})=>matchesIn(byKey.get(refKey(ref)),exactTerms).length)
    .map(({ref})=>refKey(ref)));
  const reranked=semantic.filter(v=>Number.isFinite(v.relevance)&&accept(v.ref))
    .sort((a,b)=>b.relevance-a.relevance);
  const [rerankLeader,rerankRunnerUp]=reranked;
  const positives=reranked.filter(v=>v.relevance>=0);
  // BGE often gives low absolute logits to short, valid paraphrases. Require
  // agreement with E5 and a clear lead when recovering one of those matches.
  if(!positives.length&&rerankLeader?.similarity>=0.84&&rerankLeader.relevance>=-3
    &&rerankRunnerUp&&rerankLeader.relevance-rerankRunnerUp.relevance>=1.25)positives.push(rerankLeader);
  const relevant=new Set(positives.map(v=>refKey(v.ref)));
  const rejected=new Set(reranked.map(v=>refKey(v.ref)).filter(key=>!relevant.has(key)));
  // E5's cosine scores can be close even for unrelated notes. A semantic-only
  // reminder needs a clear lead; an explicit lookup may surface alternatives.
  const denseLeader=dense[0];
  const uniqueDenseLead=denseLeader&&denseLeader.similarity>=0.82
    &&(dense.length===1?denseLeader.similarity>=0.85:denseLeader.similarity-dense[1].similarity>=0.01);
  const vector=explicitRead?dense:dense.filter(v=>lexicalKeys.has(refKey(v.ref))||contextKeys.has(refKey(v.ref))
    ||relevant.has(refKey(v.ref))||!reranked.length&&uniqueDenseLead&&v===denseLeader);
  const vectorKeys=new Set(vector.map(v=>refKey(v.ref)));
  const aboutParticipant=asked&&/(?:我|你).{0,12}(?:喜欢|偏好|习惯|关心|总是)/u.test(text);
  const persons=people.length?store.memoryPeopleRefs({people,accept:ref=>accept(ref)
    &&(aboutParticipant||lexicalKeys.has(refKey(ref))||vectorKeys.has(refKey(ref))||contextKeys.has(refKey(ref)))}):[];
  const termsSet=new Set(memoryTokens(terms.join(' ')));
  const graph=[];
  const seeds=[...new Map([...context.slice(0,2),...lexicalByEvidence.slice(0,2).map(x=>x.ref),...vector.slice(0,1).map(x=>x.ref)]
    .map(r=>[refKey(r),r])).values()].slice(0,3);
  if(seeds.length){
    const path=store.graphTrace({subjectId,query:{route:'associations',seeds:seeds.map(recordNode),maxDepth:1,maxNodes:8,maxBytes:8192,
      includeHistorical:false,offset:0,scope:[],need:'related evidence for this conversation'}});
    for(const node of path.nodes){
      const {owner:ref}=node,key=refKey(ref);
      if(node.historical||seeds.some(r=>refKey(r)===key)||!accept(ref))continue;
      const overlap=memoryTokens(byKey.get(key).body).filter(t=>termsSet.has(t)).length;
      if(contextKeys.has(key)||vectorKeys.has(key)||lexicalKeys.has(key)||overlap>=2)graph.push({ref});
    }
  }
  const lanes={lexical:lexicalByEvidence,process:context.map(ref=>({ref})),people:persons.map(ref=>({ref})),
    semantic:vector,association:graph,rerank:positives};
  const ranked=fuseConsultationRanks(lanes,{k:12,cap:explicitRead?256:24}).filter(hit=>{
    const key=refKey(hit.ref);
    return !rejected.has(key)||contextKeys.has(key)||exactKeys.has(key)||explicitRead&&!relevant.size;
  }).map(hit=>{
    const record=byKey.get(refKey(hit.ref));
    const key=refKey(hit.ref);
    const samePerson=record.anchor?.kind==='entity'&&people.includes(record.anchor.id);
    const here=record.scene===event.scene||(record.scope?.scenes??[]).includes(event.scene);
    return {...hit,record,corroborated:relevant.has(key)||contextKeys.has(key)||exactKeys.has(key),
      score:hit.score+(samePerson?0.008:0)+(here?0.004:0)+(relevant.has(key)?0.24:0)};
  }).sort((a,b)=>b.score-a.score||b.record.recordedAt-a.record.recordedAt||a.ref.id.localeCompare(b.ref.id));
  return {ranked,canDeliver,saturated:explicitRead&&lexical.length===256};
}

const similar=(a,b)=>{
  if(a===b||Math.min(a.length,b.length)>=24&&(a.includes(b)||b.includes(a)))return true;
  const x=new Set(memoryTokens(a)),y=new Set(memoryTokens(b));
  return x.size>=8&&y.size>=8&&[...x].filter(t=>y.has(t)).length/new Set([...x,...y]).size>0.85;
};

function requestedTopic(text){
  const clean=normalize(text).replace(/^(?:你)?(?:还)?记得|^(?:请|帮我|想问|说说|关于|我想知道|再看看)+/u,'');
  const topic=/^([\p{L}\p{N}_.-]{2,20})的/u.exec(clean)?.[1];
  return topic&&termsIn(topic).length?topic:null;
}

const progressQuestion=/进度|做到哪|做了什么|完成了什么|上次做了/u;
const nextQuestion=/下一步|接下来|随后|还差什么|还要做什么/u;
const singleFactQuestion=/朝哪边|哪个方向|哪一天|哪天|星期几|几号|几点|多少|价格|价钱|在哪儿|在哪里|是谁/u;
const nextEvidence=/下一步|接下来|计划|打算|尚未|待办|随后/u;
const progressEvidence=/已(?:经)?(?:完成|搭|写|接|做好|装|通过|提交)|完成了|进度|还差/u;

function chooseMemories(text,ranked){
  const rows=ranked.filter(({record})=>record.body&&chars(record.body)<=800);
  const topic=requestedTopic(text);
  const named=topic?rows.filter(({record})=>normalize(record.body).includes(topic)):[];
  const single=singleFactQuestion.test(text);
  const matching=named.length?named:topic&&single?rows.filter(row=>row.corroborated):rows;
  if(!matching.length)return [];
  const both=progressQuestion.test(text)&&nextQuestion.test(text);
  if(both){
    const progress=matching.find(({record})=>progressEvidence.test(record.body));
    const next=matching.find(({record})=>nextEvidence.test(record.body)&&record.id!==progress?.record.id);
    if(progress&&next)return [progress.record,next.record];
  }
  const chosen=[];
  const limit=!both&&single?1:2;
  for(const {record} of matching){
    const body=normalize(record.body).replace(/[\s\p{P}]/gu,'');
    if(chosen.some(other=>similar(body,other.text)))continue;
    chosen.push({record,text:body});
    if(chosen.length===limit)break;
  }
  return chosen.map(x=>x.record);
}

export function memoryReminders({store,subjectId,event:ref,now,semantic=[]}){
  const event=store.read(ref.id,ref.revision);
  if(event?.type!=='event'||!event.scene||!['observed','reported'].includes(event.origin))return [];
  const results=[];
  const {ranked,canDeliver}=rankMemory({store,subjectId,event,now,semantic});
  const pin=readPinboard(store);
  const deliver=(record,reminder)=>({ref:noteRef(record),aspect:record.type==='event'?'experience':'knowledge',reminder,
    ...(record.type==='personal_state'?{state:true}:{})});
  if(canDeliver(pin)&&typeof pin.body==='string'&&chars(pin.body)<=600)results.push(deliver(pin,'pinboard'));
  for(const record of chooseMemories(event.body,ranked))results.push(deliver(record,'related'));
  return results;
}
