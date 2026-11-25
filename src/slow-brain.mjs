// Slow-Brain v2: Dual-Track Convergent Memory Consolidation Engine.
//
// Track A (Incremental Daily Consolidation — Watermark-gated 4-stage pipeline):
//   Stage 0: Watermark slice (only events/states newer than note:slow-watermark, preventing summary drift)
//   Stage 1: Atomic Fact Extraction + Absolute Date Normalization (LLM pass 1, mandatory E# evidence)
//   Stage 2: Per-Item Hybrid Recall (BM25 + optional E5 + 1-hop graph per atom — zero query dilution)
//   Stage 3: 5-Way Structured Resolution (NOOP / ADD / AUGMENT / SUPERSEDE / LINK) + Block Pinboard + Journal
//   Stage 4: Pre-Commit Deterministic Guard (evidence check, anti-destructive augment, dedup, bi-temporal supersede)
//
// Track B (Long-Horizon Reconsolidation, Trait Emergence & Ebbinghaus Decay):
//   1. Dependency-Guided Review: detect L2 traits whose underlying L1 evidence was superseded/changed
//   2. FadeMem Decay Damping: sleep unreinforced tentative isolated fragments older than 30 days -> suspended
//   3. Cross-Day Independent-Root Trait Emergence: cluster L1 notes with >=3 independent rootIds across >=2 days
//      and consolidate from original L1/L0 evidence (never summary-of-summary recursion) into L2 traits/lessons.

import {digest,ensure,refKey} from './contracts.mjs';
import {buildStudyRequest,pricedUsage} from './model-client.mjs';
import {CORE_PINBOARD_ID,SLOW_WATERMARK_ID,extractTokens,readPinboard} from './memory-gating.mjs';
import {memoryAudience} from './memory-access.mjs';
import {rankMemory} from './memory-reminders.mjs';

export {SLOW_WATERMARK_ID};
export const TRAIT_PREFIX='note:trait:';
const DESKTOP_SCENE='local/chat';
const VALID_KINDS=new Set(['fact_claim','interpretation','value','preference','dream','tension','feeling','skill']);
const VALID_CONF=new Set(['tentative','uncertain','confident']);
const VALID_RELATIONS=new Set(['related','similar','supports','contradicts']);
const DAY_MS=24*60*60*1000;
const DECAY_DAYS=30;

function consolidationScope(previous,extra={}){
  if(previous?.scenes?.length&&!previous.scenes.includes(DESKTOP_SCENE))return null;
  return {
    scenes:[DESKTOP_SCENE],
    people:previous?.people??[],
    validFrom:extra.validFrom!==undefined?extra.validFrom:(previous?.validFrom??null),
    validUntil:extra.validUntil!==undefined?extra.validUntil:(previous?.validUntil??null)
  };
}

function safeSlice(s,max){
  const chars=[...String(s??'').trim()];
  return chars.length>max?chars.slice(0,max-1).join('')+'…':chars.join('');
}

function tokenJaccard(a,b){
  const sa=new Set(extractTokens(a)),sb=new Set(extractTokens(b));
  if(!sa.size||!sb.size)return 0;
  let inter=0;
  for(const t of sa)if(sb.has(t))inter++;
  return inter/(sa.size+sb.size-inter);
}
const criticalTokens=text=>String(text).normalize('NFKC').match(/\d+|[零一二三四五六七八九十百千]+(?=元|日|号|个|天|月)|不再|没有|不是|尚未|改为|改成/gu)?.join('|')??'';
const relativeDays={前天:-2,昨天:-1,今天:0,明天:1,后天:2};
function absoluteDayText(body,refs,{store,timezoneMinutes}){
  if(!/前天|昨天|今天|明天|后天/u.test(body))return body;
  const days=new Set(refs.map(ref=>{
    const event=store.read(ref.id,ref.revision);
    return localClockInfo(event.occurredAt??event.recordedAt,timezoneMinutes).day;
  }));
  if(days.size!==1)return body;
  const start=Date.parse([...days][0]+'T00:00:00Z');
  return body.replace(/前天|昨天|今天|明天|后天/gu,word=>new Date(start+relativeDays[word]*DAY_MS).toISOString().slice(0,10));
}

function isConsolidatableNote(n){
  if(!n||n.type!=='note'||n.status!=='current')return false;
  if(n.id.startsWith('rhythm:')||n.id.startsWith('note:journal:')||n.id.startsWith('note:seed:')||n.id===CORE_PINBOARD_ID||n.id===SLOW_WATERMARK_ID)return false;
  const scenes=n.scope?.scenes;
  if(Array.isArray(scenes)&&scenes.length>0&&!scenes.includes(DESKTOP_SCENE))return false;
  return true;
}

export function readWatermark(store){
  const rec=store?.read?.(SLOW_WATERMARK_ID);
  if(!rec)return {eventSeq:0,statePosition:0,lastEventAt:0,runs:0,lastDreamDay:null,revision:0};
  let data;
  try{data=JSON.parse(rec.body);}catch{}
  const valid=value=>Number.isSafeInteger(value)&&value>=0;
  ensure(data&&typeof data==='object'&&!Array.isArray(data)&&(valid(data.eventSeq)||valid(data.lastEventAt))
    &&['runs','lastEventAt','eventSeq','statePosition'].every(key=>data[key]===undefined||valid(data[key]))
    &&(data.lastDreamDay==null||typeof data.lastDreamDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(data.lastDreamDay)),
    'SLOW_WATERMARK','invalid slow-brain watermark');
  return {eventSeq:data.eventSeq??0,statePosition:data.statePosition??0,lastEventAt:data.lastEventAt??0,
    runs:data.runs??0,lastDreamDay:data.lastDreamDay??null,revision:rec.revision};
}

function localClockInfo(now,timezoneMinutes=480){
  const shifted=new Date(now+timezoneMinutes*60*1000);
  return {day:shifted.toISOString().slice(0,10),hour:shifted.getUTCHours()};
}

// Auto-Dream dual gate (inspired by Anthropic AutoDream):
// Only dreams automatically during sleep hours (23:00-07:00), at most once per night,
// AND only when at least `minNewEvents` new user/world events accumulated since last watermark.
const sinceFor=({lastEventAt,eventSeq,statePosition},now)=>eventSeq||statePosition?null:lastEventAt||now-36*60*60*1000;
export function shouldAutoDream({store,subjectId='jingyang',now=Date.now(),timezoneMinutes=480,minNewEvents=4,dreamFromHour=23,dreamToHour=7}={}){
  if(!store||typeof store.slowBrainInputs!=='function')return {due:false,reason:'no-store',pendingEvents:0};
  let wm;
  try{wm=readWatermark(store);}catch(error){
    if(error.code!=='SLOW_WATERMARK')throw error;
    return {due:false,reason:'invalid-watermark',pendingEvents:0};
  }
  const {day:calendarDay,hour}=localClockInfo(now,timezoneMinutes);
  const day=dreamFromHour>dreamToHour&&hour<dreamToHour?localClockInfo(now-DAY_MS,timezoneMinutes).day:calendarDay;
  const inSleepWindow=dreamFromHour<=dreamToHour?(hour>=dreamFromHour&&hour<dreamToHour):(hour>=dreamFromHour||hour<dreamToHour);
  const pendingEvents=store.slowBrainInputs({subjectId,...wm,since:sinceFor(wm,now),eventLimit:Math.max(24,minNewEvents),stateLimit:0}).events.length;
  if(!inSleepWindow)return {due:false,reason:'awake-hours',day,hour,pendingEvents,lastDreamDay:wm.lastDreamDay,runs:wm.runs};
  if(wm.lastDreamDay===day)return {due:false,reason:'already-dreamed-today',day,hour,pendingEvents,lastDreamDay:wm.lastDreamDay,runs:wm.runs};
  if(pendingEvents<minNewEvents)return {due:false,reason:'too-few-new-events',day,hour,pendingEvents,minNewEvents,lastDreamDay:wm.lastDreamDay,runs:wm.runs};
  return {due:true,reason:'ready',day,hour,pendingEvents,lastDreamDay:wm.lastDreamDay,runs:wm.runs};
}

function parsePinboardBlocks(body){
  const empty={aboutUser:'',recentFocus:'',selfStyle:'',memoryMap:''};
  if(!body)return empty;
  const about=/【关于你】([^\n【]+)/.exec(body)?.[1]?.trim()??'';
  const focus=/【近期大事】([^\n【]+)/.exec(body)?.[1]?.trim()??'';
  const self=/【自我与边界】([^\n【]+)/.exec(body)?.[1]?.trim()??'';
  const map=/【记忆地图】([^\n【]+)/.exec(body)?.[1]?.trim()??'';
  if(about||focus||self||map)return {aboutUser:about,recentFocus:focus,selfStyle:self,memoryMap:map};
  return {aboutUser:body.slice(0,200),recentFocus:'',selfStyle:'',memoryMap:''};
}

function formatPinboardBlocks(blocks){
  const lines=[];
  if(blocks.aboutUser?.trim())lines.push('【关于你】'+blocks.aboutUser.trim().slice(0,140));
  if(blocks.recentFocus?.trim())lines.push('【近期大事】'+blocks.recentFocus.trim().slice(0,140));
  if(blocks.selfStyle?.trim())lines.push('【自我与边界】'+blocks.selfStyle.trim().slice(0,130));
  if(blocks.memoryMap?.trim())lines.push('【记忆地图】'+blocks.memoryMap.trim().slice(0,140));
  return lines.join('\n').slice(0,580);
}

// ============================================================================
// Prompts for Stage 1 (Atomic Extraction), Stage 3 (5-Way Resolution), Track B (Trait Emergence)
// ============================================================================
const STAGE1_EXTRACT_SYSTEM=`你是慢脑记忆引擎的【阶段1：原子事实抽取器】。
请只从给定的新增对话（E1, E2...）与近期印象（S1, S2...）中，抽取出值得进入长期记忆的最小原子事实。
严格规则：
1. 每条原子事实只讲一件事，简洁清晰，绝不编造对话中没出现的内容。
2. 把“今天/昨天/上周/下周”等相对时间换成绝对日期。引用旧对话时以该条 E 的日期 at 为准，无法确定时保留不确定。
3. 每条填写 evidence 数组，列出支撑它的事件编号（如 ["E1"]）；本批只有印象时可使用有经历依据的 S 编号。
只输出一个合法 JSON 对象：
{
  "atoms": [
    {"id": "A1", "body": "2026-11-23：对方表示周末想去爬山", "kind": "preference|fact_claim|interpretation|value|feeling|skill|dream|tension", "confidence": "tentative|uncertain|confident", "evidence": ["E1"]}
  ]
}
最多输出 8 条；若新增对话只是纯寒暄无长期信息，输出 {"atoms": []}。`;

const STAGE3_RESOLVE_SYSTEM=`你是慢脑记忆引擎的【阶段3：结构化裁决器 & 睡前手账作者】。
输入给你：本轮抽出的原子事实（A1, A2...）以及每条各自精准匹配到的已有老笔记候选（N1, N2...）。
请对每条原子事实从 5 种操作中精确选一种：
- NOOP：老笔记已经完整记录同一件事，无需变动。
- ADD：全新独立事实，新建一条笔记（保留原 atom 的 evidence）。
- AUGMENT：并列补充细节（例如“又养了第二只狗”应把两只都保留，绝不能覆盖丢掉第一只！），更新目标 N#。
- SUPERSEDE：旧事实已失效/被推翻（例如搬家、改主意），保留旧笔记原句并标为历史，新建当前事实并自动连 contradicts 边。
- LINK：两条独立笔记存在明显支撑/关联，建立原生图谱边（supports|related|similar|contradicts）。

同时你可以：
1. 按需增量修改分块床头速写本 pinboardBlocks（仅填有变化的字段：aboutUser / recentFocus / selfStyle / memoryMap；其中 memoryMap 只放一行精简主题路标如“咖啡偏好/膝盖旧伤/工作项目”，把细节留在 notes 里，没变化省略或 null）。
2. 用主体自己的人设与说话风格写一篇 3-5 行睡前手账 journal。
3. 埋下 1-3 颗好奇种子 seeds（没有可留空）。

只输出一个合法 JSON 对象：
{
  "decisions": [
    {"atomId": "A1", "op": "NOOP|ADD|AUGMENT|SUPERSEDE|LINK", "target": "N1（从该事实的 matchedCandidates 中选）", "body": "最终正文（ADD/AUGMENT/SUPERSEDE 需要）", "kind": "preference|fact_claim|...", "confidence": "tentative|uncertain|confident"}
  ],
  "links": [
    {"from": "A1 或 N1", "to": "N2", "relation": "supports|related|similar|contradicts"}
  ],
  "pinboardBlocks": {"aboutUser": null, "recentFocus": null, "selfStyle": null, "memoryMap": null},
  "journal": "以主体口吻写的 3-5 行睡前手账",
  "seeds": ["好奇种子1"]
}`;

const TRACKB_TRAIT_SYSTEM=`你是慢脑记忆引擎的【轨道B：长期性格与经验沉淀器】。
你面前是一组跨越多天、来自多个独立真实经历的底层记忆证据簇（L1 证据），或者一条底层依据已发生变化的旧长期倾向。
请严格基于这些原始证据（绝不凭空拔高或过拟合单次偶发事件），判断是否已经形成稳定、温和、真实的长期性格倾向或处事经验。
只输出一个合法 JSON 对象：
{
  "traits": [
    {"clusterId": "C1", "promote": true, "body": "一句清晰克制的长期性格倾向或经验总结（例如：面对反复催促时倾向先冷静确认细节再行动）", "kind": "value|interpretation|skill", "confidence": "confident|tentative"}
  ]
}
如果证据还不足以定型，将 promote 设为 false。`;

// ============================================================================
// Per-Item Hybrid Recall (Stage 2) — prevents query dilution
// ============================================================================
async function recallForAtom({store,subjectId,atomBody,now,semanticMemory}){
  const event={id:'slow-brain-query',scene:DESKTOP_SCENE,body:atomBody};
  const query=extractTokens(atomBody).slice(0,12);
  if(!query.length)return [];
  const options={store,subjectId,event,now,query,acceptRecord:note=>isConsolidatableNote(note)&&!note.id.startsWith(TRAIT_PREFIX)};
  const semantic=semanticMemory?await semanticMemory.find({...options,text:atomBody}):[];
  const {ranked}=store.view(()=>rankMemory({...options,semantic}));
  return ranked.slice(0,4).map(hit=>({note:hit.record,source:hit.channels.map(lane=>lane.name).join('+')}));
}

// ============================================================================
// Track B Helpers: FadeMem Decay + Independent-Root Cross-Day Trait Clusters
// ============================================================================
export function findDecayCandidates({store,now=Date.now(),decayDays=DECAY_DAYS}={}){
  const cutoff=now-decayDays*DAY_MS;
  const notes=[...store.all('note')],protectedIds=new Set();
  for(const link of store.all('link')){
    if(link.status==='active'){protectedIds.add(link.from.id);protectedIds.add(link.to.id);}
  }
  for(const note of notes){
    if(note.status==='current')for(const ref of note.evidence??[])protectedIds.add(ref.id);
  }
  return notes.filter(n=>isConsolidatableNote(n)&&!n.id.startsWith(TRAIT_PREFIX)&&n.confidence==='tentative'
    &&n.recordedAt>0&&n.recordedAt<cutoff&&!protectedIds.has(n.id)
    &&!store.uses(n.id).some(use=>use.at>=cutoff)).slice(0,12);
}

export function findTraitClusters({store,subjectId='jingyang',now=Date.now(),timezoneMinutes=480,minIndependentRoots=3,minDaySpan=2}={}){
  const notes=[...store.all('note')];
  const allowed=memoryAudience({store,event:{scene:DESKTOP_SCENE},subjectId,now});
  const currentTraits=notes.filter(n=>n.id.startsWith(TRAIT_PREFIX)&&n.status==='current');
  const covered=new Set(currentTraits.flatMap(n=>n.evidence.map(refKey)));
  const rootDates=new Map();
  const rootDay=id=>{
    if(!rootDates.has(id)){
      const event=store.read(id);
      const supported=event?.type==='event'&&['observed','reported'].includes(event.origin)
        &&store.subjectObservation(subjectId,id)&&allowed(event);
      rootDates.set(id,supported?localClockInfo(event.occurredAt??event.recordedAt,timezoneMinutes).day:null);
    }
    return rootDates.get(id);
  };
  const kinds=new Set(['feeling','preference','value','tension','interpretation','skill']);
  const candidates=notes.filter(n=>isConsolidatableNote(n)&&!n.id.startsWith(TRAIT_PREFIX)
    &&kinds.has(n.kind)&&!covered.has(refKey(n))&&n.rootIds?.length&&allowed(n))
    .sort((a,b)=>b.recordedAt-a.recordedAt||a.id.localeCompare(b.id)).slice(0,128)
    .map(note=>({note,tokens:new Set(extractTokens(note.body)),roots:note.rootIds.filter(id=>rootDay(id))}))
    .filter(candidate=>candidate.roots.length);
  const refs=new Set(candidates.map(c=>refKey(c.note)));
  const pair=(a,b)=>[a,b].sort().join('|');
  const supported=new Set(),opposed=new Set();
  for(const link of store.all('link')){
    if(link.status!=='active'||!refs.has(refKey(link.from))||!refs.has(refKey(link.to)))continue;
    const key=pair(refKey(link.from),refKey(link.to));
    if(link.relation==='contradicts')opposed.add(key);
    else if(!store.basisChanged(link))supported.add(key);
  }
  const sameTopic=(a,b)=>{
    if(a.note.kind!==b.note.kind)return false;
    const key=pair(refKey(a.note),refKey(b.note));
    if(opposed.has(key))return false;
    if(supported.has(key))return true;
    const overlap=[...a.tokens].filter(token=>b.tokens.has(token)).length;
    return overlap>=2&&overlap/(a.tokens.size+b.tokens.size-overlap)>=0.25;
  };
  const clusters=[],selected=new Set();
  for(const anchor of candidates){
    if(selected.has(anchor.note.id))continue;
    const group=[anchor];
    for(const candidate of candidates){
      if(group.length>=6)break;
      if(candidate!==anchor&&!selected.has(candidate.note.id)&&group.every(other=>sameTopic(candidate,other)))group.push(candidate);
    }
    const roots=new Set(group.flatMap(c=>c.roots));
    const dates=new Set([...roots].map(rootDay));
    if(group.length<2||roots.size<minIndependentRoots||dates.size<minDaySpan)continue;
    clusters.push({clusterId:'C'+(clusters.length+1),kind:anchor.note.kind,independentRoots:roots.size,daySpan:dates.size,
      notes:group.map(c=>c.note)});
    for(const candidate of group)selected.add(candidate.note.id);
    if(clusters.length===2)break;
  }
  return clusters;
}

export function findTraitsNeedingReview({store}={}){
  return [...store.all('note')].filter(n=>n.id.startsWith(TRAIT_PREFIX)&&n.status==='current'
    &&(store.basisChanged(n)||n.evidence.some(ref=>store.read(ref.id)?.status!=='current'))).slice(0,3);
}

export function gatherConsolidationContext({store,subjectId='jingyang',now=Date.now(),identity='',style='',timezoneMinutes=480}={}){
  const {day}=localClockInfo(now,timezoneMinutes);
  const watermark=readWatermark(store);
  const {events,states}=store.slowBrainInputs({subjectId,...watermark,since:sinceFor(watermark,now)});
  const eventMap=new Map(),stateMap=new Map();
  const recentEvents=events.map(({record},i)=>{
    const handle='E'+(i+1);
    eventMap.set(handle,record);
    return {handle,at:localClockInfo(record.occurredAt??record.recordedAt,timezoneMinutes).day,body:safeSlice(record.body,260)};
  });
  const recentStates=states.map(({record},i)=>{
    const handle='S'+(i+1);
    stateMap.set(handle,record);
    return {handle,kind:record.kind,body:safeSlice(record.body,240),nature:record.nature??null};
  });
  const pin=readPinboard(store);
  const allowed=memoryAudience({store,subjectId,event:{scene:DESKTOP_SCENE},now});
  const pinboard=allowed(pin)?pin.body:null;
  return {day,watermark,identity:safeSlice(identity,1500),style:safeSlice(style,800),pinboard,recentEvents,recentStates,eventMap,stateMap,
    eventSeq:events.at(-1)?.position??watermark.eventSeq,statePosition:states.at(-1)?.position??watermark.statePosition};
}

async function callSlowBrainLLM({messages,maxTokens,reasoning,apiKey,journal,reqId,fetchImpl}){
  const reqBody=buildStudyRequest(messages,{maxTokens,outputFormat:'json',reasoning});
  const fingerprint=digest(reqBody),prior=journal.tryFind(reqId);
  if(prior){
    ensure(prior.fingerprint===fingerprint&&prior.status==='settled'&&prior.providerResult?.complete,
      'SLOW_REQUEST_BLOCKED','an earlier stage cannot be replayed without exact settled output');
    return JSON.parse(prior.providerResult.output);
  }
  journal.reserve(reqId,fingerprint,200000,{stage:'slow-brain-v2'});
  try{journal.dispatch(reqId);}catch(error){
    if(journal.tryFind(reqId)?.status==='reserved')journal.release(reqId,error.code??'DISPATCH_FAILED');
    throw error;
  }
  try{
    const resp=await fetchImpl('https://api.deepseek.com/chat/completions',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{'content-type':'application/json',authorization:'Bearer '+apiKey},
      body:JSON.stringify(reqBody)
    });
    if(!resp.ok){
      const code='SLOW_BRAIN_HTTP_'+resp.status;
      throw Object.assign(new Error('slow-brain model HTTP '+resp.status),{code});
    }
    const data=await resp.json();
    const choice=data?.choices?.[0],output=choice?.message?.content;
    const complete=choice?.finish_reason==='stop'&&typeof output==='string'&&output.trim().length>0;
    journal.attachProviderResult(reqId,{output:typeof output==='string'?output:null,complete,
      finishReason:choice?.finish_reason??null,providerResponseId:data?.id??null});
    ensure(data?.usage,'SLOW_USAGE_UNKNOWN','slow-brain response has no usage');
    journal.settle(reqId,pricedUsage(data.usage));
    ensure(complete,'SLOW_OUTPUT_INCOMPLETE','slow-brain response was incomplete');
    return JSON.parse(output);
  }catch(err){
    if(journal.tryFind(reqId)?.status==='dispatched')journal.uncertain(reqId,err.code??'SLOW_BRAIN_ERROR');
    throw err;
  }
}

function deterministicFallback(ctx){
  const lines=[`【${ctx.day} 睡前手账】`];
  lines.push(`今天整理了新增 ${ctx.recentEvents.length} 条互动与 ${ctx.recentStates.length} 条开放心智认识。`);
  if(ctx.recentStates.length){
    lines.push('今日记挂与认识：'+ctx.recentStates.slice(0,4).map(s=>s.body.slice(0,60)).join('；'));
  }else if(ctx.recentEvents.length){
    lines.push('今日片段：'+ctx.recentEvents.slice(-3).map(e=>e.body.slice(0,50)).join(' / '));
  }else{
    lines.push('上次整理后屋子里一直很安静，好好休整了一段时间。');
  }
  return {journal:lines.join('\n'),decisions:[],links:[],pinboardBlocks:null,seeds:[],mode:'offline-digest'};
}

// ============================================================================
// Main Entry: Dual-Track Convergent Slow Brain Consolidation
// ============================================================================
export async function runSlowBrainConsolidation({store,subjectId='jingyang',now=Date.now(),identity='',style='',live=false,apiKey='',reasoning='low',journal=null,semanticMemory=null,timezoneMinutes=480,automatic=false,fetchImpl=fetch}={}){
  ensure(store&&typeof store.execute==='function','SLOW_BRAIN','store required');
  if(live)ensure(apiKey&&journal,'SLOW_REQUEST_JOURNAL','live slow brain requires a durable request journal');
  const ctx=gatherConsolidationContext({store,subjectId,now,identity,style,timezoneMinutes});
  const audit={rejected:[],decayed:0,traitsPromoted:0,traitsNeedingReview:0};

  const watermarkCommand=fields=>({op:'write_note',id:SLOW_WATERMARK_ID,expectedRevision:ctx.watermark.revision,
    kind:'skill',body:JSON.stringify({...ctx.watermark,revision:undefined,...fields}),confidence:'confident',
    change:ctx.watermark.revision?'reinterpretation':'self_report',evidence:[],scope:consolidationScope()});
  if(automatic){
    if(!live)return {skipped:true,reason:'offline-mode'};
    const gate=shouldAutoDream({store,subjectId,now,timezoneMinutes});
    if(!gate.due)return {skipped:true,reason:gate.reason};
    const [saved]=store.execute({requestId:'slow-brain-night:'+digest({subjectId,night:gate.day}),
      commands:[watermarkCommand({lastDreamDay:gate.day})]});
    ctx.watermark={...ctx.watermark,lastDreamDay:gate.day,revision:saved.record.revision};
  }

  // --- Track A: 4-Stage Incremental Consolidation ---
  let plan=null,atoms=[],atomCandidates=new Map(),noteHandles=new Map();
  const hasNewInput=ctx.recentEvents.length>0||ctx.recentStates.length>0;
  const batchKey=digest({subjectId,eventSeq:ctx.watermark.eventSeq,statePosition:ctx.watermark.statePosition});

  const eventRef=e=>({id:e.id,revision:e.revision});
  const resolveBasis=handles=>{
    if(!Array.isArray(handles)||!handles.length||handles.length>8)return null;
    const refs=new Map();
    for(const handle of handles){
      const event=ctx.eventMap.get(handle);
      if(event){refs.set(event.id,eventRef(event));continue;}
      const state=ctx.recentEvents.length?null:ctx.stateMap.get(handle);
      const observations=(state?.basis?.observations??[]).filter(ref=>{
        const source=store.read(ref.id,ref.revision);
        return ['reported','observed'].includes(source?.origin)&&Boolean(store.subjectObservation(subjectId,source.id));
      });
      if(!observations.length)return null;
      for(const ref of observations)refs.set(ref.id,ref);
    }
    return refs.size&&refs.size<=16?[...refs.values()]:null;
  };

  if(live&&apiKey&&hasNewInput){
    // Stage 1: Atomic Fact Extraction + Absolute Date Normalization
    const stage1Out=await callSlowBrainLLM({
      messages:[
        {role:'system',content:STAGE1_EXTRACT_SYSTEM},
        {role:'user',content:JSON.stringify({day:ctx.day,recentEvents:ctx.recentEvents,recentStates:ctx.recentStates})}
      ],
      maxTokens:1600,reasoning:'off',apiKey,journal,
      reqId:'slow-brain-s1:'+batchKey,
      fetchImpl
    });
    ensure(Array.isArray(stage1Out?.atoms)&&stage1Out.atoms.length<=8,'SLOW_ATOMS','expected at most eight atoms');
    const ids=new Set();
    for(const a of stage1Out.atoms){
      ensure(typeof a?.id==='string'&&/^A[1-8]$/.test(a.id)&&!ids.has(a.id)
        &&typeof a.body==='string'&&a.body.trim(),'SLOW_ATOMS','invalid or duplicate atom');
      ids.add(a.id);
      const refs=resolveBasis(a.evidence);
      if(!refs){audit.rejected.push({atomId:a.id,reason:'MISSING_EVIDENCE'});continue;}
      atoms.push({id:a.id,body:safeSlice(absoluteDayText(a.body,refs,{store,timezoneMinutes}),400),kind:VALID_KINDS.has(a.kind)?a.kind:'interpretation',
        confidence:VALID_CONF.has(a.confidence)?a.confidence:'tentative',evidence:a.evidence,refs});
    }

    // Stage 2: Per-Item Hybrid Recall (zero query dilution)
    let nIdx=0;
    const noteIdToHandle=new Map();
    const candidatesView=[];
    for(const atom of atoms){
      const matched=await recallForAtom({store,subjectId,atomBody:atom.body,now,semanticMemory});
      const handlesForAtom=[];
      for(const {note,source} of matched){
        let h=noteIdToHandle.get(note.id);
        if(!h){
          h='N'+(++nIdx);
          noteIdToHandle.set(note.id,h);
          noteHandles.set(h,note);
          candidatesView.push({handle:h,kind:note.kind,confidence:note.confidence,source,body:safeSlice(note.body,800),
            editable:[...note.body.trim()].length<=800});
        }
        handlesForAtom.push(h);
      }
      atomCandidates.set(atom.id,handlesForAtom);
    }

    // Stage 3: 5-Way Structured Resolution + Block Pinboard + Bedtime Journal
    const stage3Payload={
      day:ctx.day,identity:ctx.identity,style:ctx.style,
      pinboardBlocks:parsePinboardBlocks(ctx.pinboard),
      atoms:atoms.map(({refs,...a})=>({...a,matchedCandidates:atomCandidates.get(a.id)??[]})),
      candidateNotes:candidatesView,
      recentEvents:ctx.recentEvents.slice(-8)
    };
    const stage3Out=await callSlowBrainLLM({
      messages:[{role:'system',content:STAGE3_RESOLVE_SYSTEM},{role:'user',content:JSON.stringify(stage3Payload)}],
      maxTokens:reasoning==='high'?4000:2600,reasoning,apiKey,journal,
      reqId:'slow-brain-s3:'+batchKey,
      fetchImpl
    });
    const choices=stage3Out?.decisions;
    ensure(Array.isArray(choices)&&choices.length===atoms.length&&new Set(choices.map(d=>d?.atomId)).size===atoms.length
      &&choices.every(d=>atomCandidates.has(d?.atomId)&&['NOOP','ADD','AUGMENT','SUPERSEDE','LINK'].includes(d.op)),
      'SLOW_DECISIONS','each delivered atom needs one explicit resolution');
    plan={
      journal:typeof stage3Out?.journal==='string'&&stage3Out.journal.trim()?safeSlice(stage3Out.journal,3600):deterministicFallback(ctx).journal,
      decisions:choices,
      links:Array.isArray(stage3Out?.links)?stage3Out.links.slice(0,6):[],
      pinboardBlocks:stage3Out?.pinboardBlocks&&typeof stage3Out.pinboardBlocks==='object'?stage3Out.pinboardBlocks:null,
      seeds:Array.isArray(stage3Out?.seeds)?stage3Out.seeds.slice(0,3):[],
      mode:'slow-brain-v2'
    };
  }else{
    plan=deterministicFallback(ctx);
  }

  // --- Stage 4: Pre-Commit Deterministic Guard & Atomic Commit ---
  const noteCommands=[];
  const supersedePairs=[]; // {oldId, newId}
  const atomToRef=new Map();
  const touchedNoteIds=new Set();
  const eligible=memoryAudience({store,subjectId,event:{scene:DESKTOP_SCENE},now});
  const allCurrentNotes=[...store.all('note')].filter(n=>isConsolidatableNote(n)&&eligible(n));
  const safeChangeKind=(evRefs,existing=null)=>{
    const priorRoots=new Set(existing?.rootIds??[]);
    let hasNewRoot=false;
    for(const r of evRefs??[]){
      const rec=store.read(r.id,r.revision);
      if(!rec)continue;
      const roots=rec.type==='event'?[rec.id]:(rec.rootIds??[]);
      if(roots.some(id=>!priorRoots.has(id))){hasNewRoot=true;break;}
    }
    return hasNewRoot?'new_evidence':(existing?'reinterpretation':'self_report');
  };

  let notesCreated=0,notesUpdated=0,notesSuperseded=0;
  const atomById=new Map(atoms.map(a=>[a.id,a]));

  for(const dec of plan.decisions){
    const op=dec.op;
    if(op==='NOOP')continue;
    const atom=atomById.get(dec.atomId);
    let body=typeof dec.body==='string'&&dec.body.trim()?dec.body.trim():atom.body;
    if(op!=='AUGMENT')body=absoluteDayText(body,atom.refs,{store,timezoneMinutes});
    const kind=VALID_KINDS.has(dec?.kind)?dec.kind:(atom?.kind??'interpretation');
    const confidence=VALID_CONF.has(dec?.confidence)?dec.confidence:(atom?.confidence??'tentative');
    const evRefs=atom.refs;
    if(dec.evidence!==undefined&&(!Array.isArray(dec.evidence)||!dec.evidence.length
      ||dec.evidence.some(handle=>!atom.evidence.includes(handle)))){
      audit.rejected.push({atomId:dec.atomId,op,reason:'EVIDENCE_OUTSIDE_ATOM'});
      continue;
    }
    const target=atomCandidates.get(atom.id).includes(dec.target)?noteHandles.get(dec.target):null;
    if(op!=='ADD'&&(!target||store.read(target.id)?.revision!==target.revision
      ||!eligible(target)||touchedNoteIds.has(target.id)||op!=='LINK'&&[...target.body.trim()].length>800)){
      audit.rejected.push({atomId:dec.atomId,op,reason:'INVALID_TARGET'});
      continue;
    }
    if(op==='LINK'){
      atomToRef.set(atom.id,evRefs[0]);
      plan.links.push({from:atom.id,to:dec.target,relation:VALID_RELATIONS.has(dec.relation)?dec.relation:'related'});
      continue;
    }
    if(!body||body.length>3800)continue;

    if(op==='ADD'){
      // Guard 2: Deduplication against existing current notes
      const dup=allCurrentNotes.find(n=>n.kind===kind&&criticalTokens(n.body)===criticalTokens(body)&&tokenJaccard(n.body,body)>=0.85);
      if(dup){
        audit.rejected.push({atomId:dec?.atomId??null,op,reason:'DUPLICATE_EXISTING',existingId:dup.id});
        atomToRef.set(atom.id,eventRef(dup));
        continue;
      }
      const id='note:slow:'+digest({kind,body,evRefs});
      atomToRef.set(atom.id,{id,revision:1});
      if(store.read(id)||noteCommands.some(c=>c.id===id))continue;
      noteCommands.push({
        op:'write_note',id,expectedRevision:0,kind,body,status:'current',confidence,
        change:safeChangeKind(evRefs,null),evidence:evRefs,scope:consolidationScope(null,{validFrom:now})
      });
      notesCreated++;
    }else if(op==='AUGMENT'){
      const scope=consolidationScope(target?.scope);
      if(!target||!scope||touchedNoteIds.has(target.id)){
        audit.rejected.push({atomId:dec?.atomId??null,op,reason:'INVALID_TARGET'});continue;
      }
      // Guard 3: Anti-destructive augment (never shrink existing note by >40%)
      const normalized=text=>String(text).normalize('NFKC').replace(/\s+/g,'');
      if(body.length<target.body.length*0.6||!normalized(body).includes(normalized(target.body))){
        const fallbackId='note:slow:'+digest({kind,body,evRefs});
        atomToRef.set(atom.id,{id:fallbackId,revision:1});
        plan.links.push({from:atom.id,to:dec.target,relation:'related'});
        if(!store.read(fallbackId)&&!noteCommands.some(c=>c.id===fallbackId)){
          noteCommands.push({
            op:'write_note',id:fallbackId,expectedRevision:0,kind,body,status:'current',confidence,
            change:safeChangeKind(evRefs,null),evidence:evRefs,scope:consolidationScope(null,{validFrom:now})
          });
          notesCreated++;
          audit.rejected.push({atomId:dec?.atomId??null,op,reason:'DOWNGRADED_DESTRUCTIVE_AUGMENT_TO_ADD'});
        }
        continue;
      }
      const mergedEvidence=[...new Map([...(target.evidence??[]),...evRefs].map(r=>[refKey(r),r])).values()];
      if(mergedEvidence.length>16){audit.rejected.push({atomId:atom.id,op,reason:'EVIDENCE_LIMIT'});continue;}
      noteCommands.push({
        op:'write_note',id:target.id,expectedRevision:target.revision,kind:target.kind,body,
        status:'current',confidence,change:safeChangeKind(mergedEvidence,target),
        evidence:mergedEvidence,scope
      });
      touchedNoteIds.add(target.id);
      atomToRef.set(atom.id,{id:target.id,revision:target.revision+1});
      notesUpdated++;
    }else if(op==='SUPERSEDE'){
      // Bi-temporal supersede: preserve old text untouched, stamp validUntil=now & historical, add new + contradicts link
      const old=target;
      const candidateScope=consolidationScope(old.scope);
      if(!candidateScope||safeChangeKind(evRefs,old)!=='new_evidence'||body===old.body){
        audit.rejected.push({atomId:dec?.atomId??null,op,reason:'INVALID_SUPERSEDE_TARGET'});continue;
      }
      const newId='note:slow:'+digest({kind,body,evRefs,supersedes:old.id});
      const priorReplacement=store.read(newId);
      if(priorReplacement&&priorReplacement.status!=='current'){
        audit.rejected.push({atomId:atom.id,op,reason:'STALE_REPLACEMENT'});continue;
      }
      const safeValidUntil=Math.max(now,(old.scope.validFrom??-1)+1);
      if(candidateScope.validUntil!==null&&candidateScope.validUntil<=safeValidUntil){
        audit.rejected.push({atomId:atom.id,op,reason:'INVALID_VALIDITY'});continue;
      }
      const oldScope={...old.scope,validUntil:safeValidUntil};
      noteCommands.push({
        op:'write_note',id:old.id,expectedRevision:old.revision,kind:old.kind,body:old.body,
        status:'historical',confidence:old.confidence??'tentative',change:'reinterpretation',
        evidence:old.evidence??[],scope:oldScope
      });
      touchedNoteIds.add(old.id);
      if(!store.read(newId)&&!noteCommands.some(c=>c.id===newId)){
        noteCommands.push({
          op:'write_note',id:newId,expectedRevision:0,kind,body,status:'current',confidence,
          change:safeChangeKind(evRefs,null),evidence:evRefs,scope:{...candidateScope,validFrom:safeValidUntil}
        });
      }
      atomToRef.set(atom.id,{id:newId,revision:1});
      supersedePairs.push({oldId:old.id,newId});
      notesSuperseded++;
    }
  }

  // Block-based Core Pinboard update (incremental per block, never wipes untouched blocks)
  let pinboardUpdated=false;
  if(plan.pinboardBlocks){
    const oldPin=store.read(CORE_PINBOARD_ID);
    const merged=parsePinboardBlocks(oldPin?.body??'');
    let changed=false;
    for(const k of ['aboutUser','recentFocus','selfStyle','memoryMap']){
      if(typeof plan.pinboardBlocks[k]==='string'&&plan.pinboardBlocks[k].trim()&&plan.pinboardBlocks[k].trim()!==merged[k]){
        merged[k]=plan.pinboardBlocks[k].trim();changed=true;
      }
    }
    const nextPinBody=formatPinboardBlocks(merged);
    const scope=consolidationScope(oldPin?.scope);
    if(changed&&nextPinBody&&scope){
      noteCommands.push({
        op:'write_note',id:CORE_PINBOARD_ID,expectedRevision:oldPin?.revision??0,
        kind:'interpretation',body:nextPinBody,status:'current',confidence:'confident',
        change:oldPin?'reinterpretation':'self_report',evidence:oldPin?.evidence??[],scope
      });
      pinboardUpdated=true;
    }
  }

  // Bedtime journal
  const journalId='note:journal:'+ctx.day;
  const existingJournal=store.read(journalId);
  noteCommands.push({
    op:'write_note',id:journalId,expectedRevision:existingJournal?.revision??0,
    kind:'interpretation',body:plan.journal,status:'current',confidence:'tentative',
    change:existingJournal?'reinterpretation':'self_report',evidence:[],scope:consolidationScope()
  });

  // Curiosity seeds
  let seedsPlanted=0;
  for(const seed of plan.seeds){
    const body=typeof seed==='string'?seed.trim():'';
    if(!body||body.length>400)continue;
    const id='note:seed:'+digest({day:ctx.day,body});
    if(store.read(id)||noteCommands.some(c=>c.id===id))continue;
    noteCommands.push({
      op:'write_note',id,expectedRevision:0,kind:'dream',body,status:'current',confidence:'tentative',
      change:'self_report',evidence:[],scope:consolidationScope()
    });
    seedsPlanted++;
  }

  const pendingNotes=new Map(noteCommands.map(command=>[command.id,{id:command.id,revision:command.expectedRevision+1}]));
  const resolveNoteRef=token=>{
    const key=String(token??'').trim();
    const atom=atomToRef.get(key);
    if(atom)return atom;
    const known=noteHandles.get(key);
    return known&&store.read(known.id)?.revision===known.revision&&eligible(known)
      ?pendingNotes.get(known.id)??eventRef(known):null;
  };
  const linkCommands=[];
  const pushLink=(from,to,relation,strength)=>{
    if(!from||!to||from.id===to.id)return;
    const id='link:slow:'+digest({from,to,relation});
    if(store.read(id)||linkCommands.some(c=>c.id===id))return;
    linkCommands.push({
      op:'write_link',id,expectedRevision:0,from,to,relation,
      strength,direction:relation==='related'||relation==='similar'?'both':'forward',
      basis:[],status:'active'
    });
  };
  for(const pair of supersedePairs){
    pushLink(pendingNotes.get(pair.newId)??eventRef(store.read(pair.newId)),pendingNotes.get(pair.oldId),'contradicts',1.0);
  }
  for(const l of plan.links){
    const relation=VALID_RELATIONS.has(l?.relation)?l.relation:null;
    if(!relation)continue;
    pushLink(resolveNoteRef(l?.from),resolveNoteRef(l?.to),relation,relation==='supports'?0.85:0.7);
  }
  const guardedIds=new Set([...noteHandles.values()].map(note=>note.id));
  const decayCommands=live&&hasNewInput?findDecayCandidates({store,now}).filter(n=>eligible(n)&&!guardedIds.has(n.id))
    .map(n=>({op:'write_note',id:n.id,expectedRevision:n.revision,kind:n.kind,body:n.body,status:'suspended',
      confidence:n.confidence,change:'reinterpretation',evidence:n.evidence,scope:n.scope})):[];
  audit.decayed=decayCommands.length;
  const commands=[...noteCommands,...linkCommands,...decayCommands];
  if(live&&hasNewInput)commands.push(watermarkCommand({eventSeq:ctx.eventSeq,statePosition:ctx.statePosition,runs:ctx.watermark.runs+1}));
  store.execute({requestId:'slow-brain-v2-commit:'+ctx.day+':'+digest(commands),commands});

  // --- Track B2: Cross-Day Trait/Experience Emergence & Dependency Review (LLM when live) ---
  const traitClusters=live?findTraitClusters({store,subjectId,now,timezoneMinutes}):[];
  const reviewTraits=findTraitsNeedingReview({store});
  audit.traitsNeedingReview=reviewTraits.length;
  if(live&&traitClusters.length){
    try{
      const clusterMap=new Map(traitClusters.map(c=>[c.clusterId,c]));
      const traitOut=await callSlowBrainLLM({
        messages:[
          {role:'system',content:TRACKB_TRAIT_SYSTEM},
          {role:'user',content:JSON.stringify({
            clusters:traitClusters.map(c=>({clusterId:c.clusterId,kind:c.kind,independentRoots:c.independentRoots,daySpan:c.daySpan,evidenceNotes:c.notes.map(n=>({id:n.id,body:n.body}))}))
          })}
        ],
        maxTokens:1600,reasoning:'off',apiKey,journal,
        reqId:'slow-brain-trackb:'+digest({subjectId,clusters:traitClusters.map(c=>c.notes.map(eventRef))}),
        fetchImpl
      });
      const traitCmds=[];
      for(const t of Array.isArray(traitOut?.traits)?traitOut.traits.slice(0,2):[]){
        if(t?.promote!==true||typeof t.body!=='string'||!t.body.trim())continue;
        const cluster=clusterMap.get(String(t.clusterId??''));
        if(!cluster)continue;
        const body=safeSlice(t.body,400);
        const kind=['value','interpretation','skill'].includes(t.kind)?t.kind:'value';
        const confidence=VALID_CONF.has(t.confidence)?t.confidence:'confident';
        const evRefs=cluster.notes.map(n=>({id:n.id,revision:n.revision}));
        const id=TRAIT_PREFIX+digest({kind,body});
        if(store.read(id)||traitCmds.some(c=>c.id===id))continue;
        traitCmds.push({
          op:'write_note',id,expectedRevision:0,kind,body,status:'current',confidence,
          change:safeChangeKind(evRefs,null),evidence:evRefs,scope:consolidationScope(null,{validFrom:now})
        });
      }
      if(traitCmds.length){
        store.execute({requestId:'slow-brain-v2-traits:'+ctx.day+':'+digest(traitCmds),commands:traitCmds});
        audit.traitsPromoted=traitCmds.length;
      }
    }catch(error){audit.traitError=error.code??'SLOW_TRAIT_FAILED';}
  }

  const savedJournal=store.read(journalId);
  return {
    mode:plan.mode,day:ctx.day,
    journal:{id:savedJournal.id,revision:savedJournal.revision,day:ctx.day,body:savedJournal.body,recordedAt:savedJournal.recordedAt??now},
    pinboardUpdated,notesCreated,notesUpdated,notesArchived:notesSuperseded,
    linksCreated:linkCommands.length,seedsPlanted,
    audit
  };
}
