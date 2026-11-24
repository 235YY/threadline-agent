// Strict Retrieval Gating + 1-Hop Graph-Boosted Flashback + Core Pinboard.
// Inspired by Retrieval Gating (RAGate/Self-RAG), HippoRAG (graph-assisted recall),
// and Zep/Graphiti (active-only temporal filtering).
// Pure deterministic read-only selection: never mutates the store, never forces Top-K
// on casual chitchat (zero context pollution).

export const CORE_PINBOARD_ID='note:core-pinboard';
export const SLOW_WATERMARK_ID='note:slow-watermark';

const CASUAL_ONLY=/^(?:你好|您好|早|早安|早上好|午安|晚安|睡了|在吗|在不在|哈+|呵+|嘿+|嗯+|哦+|好吧|好的|行|ok|okay|hi|hello|hey|thanks|thx|谢谢|谢了|没事|好的呀|知道了|收到|好累|累了|困了|摸摸|贴贴|抱抱)[！!。.~～？?，,\s]*$/i;
const ANAPHORA_CUES=/(?:上次|之前|以前|老规矩|那个|那件|后来|记得|还记得|提过|说过|答应|约定|上次聊|上周|昨天|前几天|前面|原来)/;
const STOP_TOKENS=new Set(['这个','那个','什么','怎么','为什么','可以','已经','还是','就是','觉得','因为','所以','如果','但是','而且','一个','一下','现在','今天','明天','这里','那里','我们','你们','他们','自己','知道','没有','不是','不会','需要','应该','可能','比较','非常','真的','有点','一直','大家','东西','事情']);

export function extractTokens(text){
  const s=String(text??'').trim().toLowerCase();
  if(!s)return [];
  const tokens=new Set();
  // Latin / alphanumeric terms (len >= 3)
  for(const m of s.matchAll(/[a-z0-9_.-]{3,32}/g))tokens.add(m[0]);
  // CJK segments -> 2-gram and 3-gram content terms
  for(const seg of s.matchAll(/[\p{Script=Han}]{2,}/gu)){
    const w=seg[0];
    if(w.length<=4){
      if(!STOP_TOKENS.has(w))tokens.add(w);
    }else{
      for(let i=0;i<=w.length-2;i++){
        const bi=w.slice(i,i+2);
        if(!STOP_TOKENS.has(bi))tokens.add(bi);
      }
      for(let i=0;i<=w.length-3;i++){
        const tri=w.slice(i,i+3);
        if(!STOP_TOKENS.has(tri))tokens.add(tri);
      }
    }
  }
  return [...tokens];
}

// Strict gate: returns {open:false} for casual chitchat so zero irrelevant memories pollute context.
export function shouldGateRetrieve(text){
  const s=String(text??'').trim();
  if(!s||s.length<3)return {open:false,reason:'too-short'};
  if(CASUAL_ONLY.test(s))return {open:false,reason:'casual-chitchat'};
  const hasAnaphora=ANAPHORA_CUES.test(s);
  const tokens=extractTokens(s);
  if(hasAnaphora)return {open:true,reason:'anaphora',tokens,anaphora:true};
  if(tokens.length>=2&&s.length>=8)return {open:true,reason:'substantive',tokens,anaphora:false};
  return {open:false,reason:'insufficient-signal'};
}

export function readPinboard(store){
  const rec=store?.read?.(CORE_PINBOARD_ID);
  if(!rec||rec.type!=='note'||rec.status!=='current')return null;
  return rec;
}

// Select at most `maxItems` high-confidence current notes as pinned materials.
// Uses token overlap + 1-hop active graph link boost (supports/related/similar) + recency,
// with a hard minimum threshold so weak matches are dropped rather than forced in.
export function selectGatedMaterials({store,event=null,now=Date.now(),maxItems=2,accept=()=>true}={}){
  if(!store||typeof store.all!=='function')return [];
  const out=[];
  const pinboard=readPinboard(store);
  if(pinboard&&accept(pinboard))out.push({ref:{id:pinboard.id,revision:pinboard.revision},aspect:'knowledge'});

  const ev=event?.body!==undefined?event:(event?.id?store.read(event.id,event.revision):null);
  if(!ev||ev.origin==='tool_receipt')return out;
  const gate=shouldGateRetrieve(ev.body);
  if(!gate.open||!gate.tokens?.length)return out;

  const querySet=new Set(gate.tokens);
  const candidates=[...store.all('note')].filter(n=>
    n.status==='current'&&
    !n.id.startsWith('rhythm:')&&
    n.id!==CORE_PINBOARD_ID&&
    !n.id.startsWith('note:journal:')&&n.id!==SLOW_WATERMARK_ID&&accept(n)
  );
  if(!candidates.length)return out;

  // Build active 1-hop graph adjacency from native Threadline links
  const neighbors=new Map();
  const addEdge=(a,b,w)=>{
    if(!neighbors.has(a))neighbors.set(a,[]);
    neighbors.get(a).push({id:b,weight:w});
  };
  for(const l of store.all('link')){
    if(l.status!=='active'||l.relation==='contradicts')continue;
    const w=(Number.isFinite(l.strength)?l.strength:0.5)*(l.relation==='supports'?1.2:1.0);
    if(l.from?.id&&l.to?.id){
      addEdge(l.from.id,l.to.id,w);
      if(l.direction==='both')addEdge(l.to.id,l.from.id,w);
    }
  }

  // First pass: lexical overlap score
  const directScore=new Map();
  for(const n of candidates){
    const nTokens=extractTokens(n.body);
    if(!nTokens.length)continue;
    let hits=0;
    for(const t of nTokens)if(querySet.has(t))hits++;
    if(hits===0)continue;
    const overlap=hits/Math.sqrt(querySet.size*Math.min(nTokens.length,24));
    const ageDays=Math.max(0,(now-(n.recordedAt??now))/(86400*1000));
    const recency=1/(1+ageDays/30);
    const kindBoost=n.kind==='preference'||n.kind==='fact_claim'?1.15:1.0;
    directScore.set(n.id,(overlap*0.8+recency*0.2)*kindBoost);
  }

  // Second pass: 1-hop graph diffusion (lightweight HippoRAG-style boost)
  const finalScores=[];
  const MIN_SCORE=gate.anaphora?0.28:0.38;
  for(const n of candidates){
    let score=directScore.get(n.id)??0;
    let graphBoost=0;
    for(const edge of neighbors.get(n.id)??[]){
      const ns=directScore.get(edge.id)??0;
      if(ns>0.25)graphBoost=Math.max(graphBoost,ns*edge.weight*0.35);
    }
    score+=graphBoost;
    if(score>=MIN_SCORE)finalScores.push({note:n,score});
  }

  finalScores.sort((a,b)=>b.score-a.score||(b.note.recordedAt??0)-(a.note.recordedAt??0));
  for(const item of finalScores.slice(0,maxItems)){
    out.push({ref:{id:item.note.id,revision:item.note.revision},aspect:'knowledge'});
  }
  return out;
}
