// Intent protocol v1: the model states what it means; the host writes the transaction.
//
// The full decision protocol asks the model to hand-write a nested transaction
// (options/selected/continuity.changes/residency/attention.processes/…) under a
// ~30KB instruction. Real runs failed on that bookkeeping far more than on meaning.
// Here the model sees a plain projection of the same sealed base packet with short
// handles (E0/S1/P1/M1/T1) and answers with a small intent object. The host
// compiles it into the ordinary full output, which is then committed through the
// unchanged path: every source, version, permission and atomicity check still runs.
//
// What the host fills is limited to bookkeeping that is fully determined by the
// delivered packet or by an explicit model choice: ids for new objects, versions,
// basis = the current observation, residency for states the model keeps, and the
// event→process link only when the model marks thisMessage. It never invents a
// state, a process, an association, a tool call or a reply.
import {canonical,digest,ensure,refKey} from './contracts.mjs';
import {verifiedModelInput} from './cognition.mjs';
import {keepAttention,ATTENTION_CAPACITY_HINT} from './attention.mjs';
import {toolContract} from './tool-contracts.mjs';
import {generationSets} from './prompt-generations.mjs';
import {deliveredStateRefs} from './revision-derivation.mjs';
import {normalizeDomains} from './personal-state.mjs';
import {formatRelativeTime,resolveSpeakerName} from './social-projection.mjs';

export const INTENT_STAGE='intent-v1';
const PROMPTS=generationSets(read=>{
  const prompts={intent:read('intent-v1.zh.md'),anti:read('anti-assistant.zh.md')};
  try{prompts.home=read('intent-home.zh.md');}catch(error){if(error.code!=='ENOENT')throw error;}
  return prompts;
});
const DECISION_STAGES=['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph'];
const STATE_KINDS=['feeling','appraisal','intention','tension','activity','impression'];
const pagedLookup=p=>['intent-base-v4','intent-base-v5'].includes(p.intentProtocol?.format);
const homeView=p=>pagedLookup(p)||p.intentProtocol?.format==='intent-base-v3'||p.internal?.kind==='autonomy'&&Object.hasOwn(p.internal,'timezoneMinutes');
const richView=p=>pagedLookup(p)||['intent-base-v2','intent-base-v3'].includes(p.intentProtocol?.format);
const mergedView=p=>p.intentProtocol?.verifiedZip===true||p.internal?.verifiedZip===true;
const READINESS_LINKS={belief:'appraisals',concern:'concerns',condition:'conditions',expectation:'expectations'};
const MIND_CHOICES={concern:['seek','preserve','avoid'],condition:['available','unavailable','unknown']};
const MIND_INPUT=`只在值得记下时才写 states。可用 appraisal 附 confidence（tentative/uncertain/confident）记下暂定认识；concern 用 stance:seek/preserve/avoid 记长期关切；condition 用 stance:available/unavailable/unknown 记条件判断；readiness 用 links:[S编号] 把已交付的认识和关切连成行动准备。可选 domains: [self/relationship/world/normative 中适用的项]。修改前用 S 编号；不确定就保留不确定。已有判断、准备关系、情绪和带来源类型的任务结果在 view 中供你参考，它们都不替你决定该做什么。若 view.canInterpret 为 true，可用 perception: {domain,meaning} 表达对当前经历的统觉判断，不必有情绪；moodEval 可同时给，现有情绪与它的对象、原因可帮助你判断。start_agent_task 的 processId/intentId 可填本轮 P/G 编号；没有明确归属就省略。任务完成和目标完成是两件事。`;
const WORK_STATUS=['proposed','active','paused','completed','abandoned'];
const LEGACY_AUTONOMY_INSTRUCTION=`这是你自己的时间。你可以看看自己现在的目标和手上的事，再决定接下来想做什么。
你可以形成目标、修改目标、继续或放弃原来的目标，也可以启动一件已被允许的事，或者只是等一等、什么都不做。
没有人在等你回复，也不需要为了证明自己在思考而写内容；不行动是合法的。
创建目标用 intent 加 goal；修改或放弃已有目标时带 handle（如 G1）；启动任务用 act，tool 为 start_agent_task，可带目标 handle。
说明可以很短。不要编造经历、感受或计划来填满输出。`;
const ZIP_AUTONOMY_INSTRUCTION=`这是属于你自己的自由时间，没人催你。先感受一下 view.feltSense（你此刻的精力、心境和内在冲动），再顺手扫一眼 view.deskCues（桌边现在顺手可以做的小事）和你已有的目标、手头的事。
如果你心里正冒出某个好奇、想推进一件事、想记下刚想通的一点认识，或者挂念某个人想发句近况（只要工具里有对应能力），都可以顺着自己的真实想法去做；如果此刻确实想安静歇着，选 wait 或什么都不做也完全没问题。
创建或调整目标用 intent（新目标写 goal，修改已有目标带 handle 如 G1）；要动手做事用 act 并选用 view.tools 里列出的工具（例如 start_agent_task、remember_note、proactive_contact 等）。
说明可以很短，随心而发就好，但不要编造没发生过的经历或硬凑计划。`;
const STATUS={sent:'confirmed',pending:'pending',dispatching:'pending',failed:'failed',unknown:'unknown'};
const LOCAL_TIME_ZONE='Asia/Shanghai';
function localTimeProjection(epochMs){
  if(!Number.isSafeInteger(epochMs))return null;
  const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:LOCAL_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(epochMs)).replace('T',' ');
  return {localTime,timeZone:LOCAL_TIME_ZONE};
}
function addTimeProjection(view,nowMs,lastAt=null,withFeel=false){
  if(nowMs===null)return view;
  view.now=new Date(nowMs).toISOString();
  const local=localTimeProjection(nowMs);
  if(local){view.localTime=local.localTime;view.timeZone=local.timeZone;}
  const tf=withFeel?timeSense({nowMs,lastAt,localTime:local?.localTime??null}):null;
  if(tf)view.timeFeel=tf;
  return view;
}
// Deterministic warm time perception: translates clock hour + gap since last interaction
// into a natural sense of time passing (pure function of sealed packet timestamps).
export function timeSense({nowMs,lastAt=null,localTime=null}={}){
  if(!Number.isSafeInteger(nowMs))return null;
  const parts=[];
  let hour=null;
  if(typeof localTime==='string'&&localTime.length>=13){
    const h=Number(localTime.slice(11,13));
    if(Number.isSafeInteger(h))hour=h;
  }
  if(hour!==null){
    if(hour>=5&&hour<9)parts.push('现在是清晨，新的一天刚开始。');
    else if(hour>=9&&hour<12)parts.push('现在是上午，光线正好。');
    else if(hour>=12&&hour<14)parts.push('现在是中午时分。');
    else if(hour>=14&&hour<18)parts.push('现在是下午，节奏比较舒展。');
    else if(hour>=18&&hour<22)parts.push('现在是傍晚到晚间，一天快收尾了。');
    else if(hour>=22||hour<2)parts.push('现在已经是深夜了，周围安静下来了。');
    else parts.push('现在是凌晨深更半夜，大家多半都在睡觉。');
  }
  if(Number.isSafeInteger(lastAt)&&nowMs>=lastAt){
    const gapMin=Math.floor((nowMs-lastAt)/60000);
    if(gapMin>=72*60)parts.push(`距离上次互动已经过去 ${Math.floor(gapMin/1440)} 天了，算是久别重逢。`);
    else if(gapMin>=24*60)parts.push(`距离上次互动已经隔了一天多（约 ${Math.floor(gapMin/60)} 小时）。`);
    else if(gapMin>=6*60)parts.push(`距离上次互动已经过去 ${Math.floor(gapMin/60)} 个多小时了。`);
    else if(gapMin>=90)parts.push(`距离上次说话隔了 ${Math.floor(gapMin/60)} 个多小时。`);
  }
  return parts.length?parts.join(''):null;
}

function addHomeOrientation(view,p,nowMs,withZip=false){
  const offset=p.intentProtocol?.timezoneMinutes??p.internal?.timezoneMinutes??480;
  const shifted=new Date(nowMs+offset*60_000);
  if(Number.isSafeInteger(nowMs)&&Number.isFinite(shifted.getTime())){
    const hh=shifted.getUTCHours();
    const last=p.continuity.recent?.items?.findLast(item=>item.role==='user'&&item.ref?.id!==p.current?.id&&item.at<=nowMs);
    const lastAt=last?.at??(withZip?p.continuity.lastReaction?.at:null);
    const ago=formatRelativeTime(lastAt,nowMs);
    const period=hh<6?'深夜':hh<11?'早上':hh<14?'中午':hh<19?'下午':hh<23?'晚上':'深夜';
    view.timeFeel={now:shifted.toISOString().slice(0,16).replace('T',' '),utcOffsetMinutes:offset,period,
      ...(ago?{[p.current?'lastMessageHere':'lastMessage']:ago}:{})};
    const description=withZip?timeSense({nowMs,lastAt,localTime:view.timeFeel.now}):null;
    if(description)view.timeFeel.text=description;
  }
  const projection=p.continuity.motivation?.projection;
  if(!projection)return;
  const {mood={},drives={}}=projection;
  const feel=[];
  if(mood.p>=0.30)feel.push('心情偏轻快');
  else if(mood.p<=-0.30)feel.push('心情偏低落');
  if(mood.a>=0.35)feel.push('有些兴奋');
  else if(mood.a<=-0.35)feel.push('心里比较安静');
  const needs={social:'想和人聊聊',novelty:'想看看新东西',competence:'想推进一件事',
    recognition:'在意有没有得到回应',fatigue:'有点累',sleepiness:'有点困'};
  const strongest=Object.entries(needs).filter(([name])=>drives[name]>=0.65)
    .sort(([a],[b])=>drives[b]-drives[a]).slice(0,2);
  for(const [,sense] of strongest)feel.push(sense);
  view.feltSense={text:(withZip?somaticFeel(p.continuity.motivation):null)||feel.slice(0,3).join('，')||'心情和精力都比较平稳',
    ...(Number.isSafeInteger(p.continuity.motivation.asOf)&&Number.isSafeInteger(nowMs)?
      {asOf:formatRelativeTime(p.continuity.motivation.asOf,nowMs)}:{})};
}
const fail=(code,message,details)=>ensure(false,code,message,details);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const str=(v,name,max)=>{ensure(typeof v==='string'&&v.trim().length>0,'INTENT_SHAPE',`${name} must be nonempty text`,{path:name});ensure([...v].length<=max,'INTENT_LIMIT',`${name} longer than ${max}`,{path:name});return v;};

// Packets this protocol can carry. Reflection, task steps and packets with unsupported host
// instruction suffixes (task results, re-admission) keep the full protocol.
const UNSUPPORTED_SUFFIX_MARKERS=['这是 AgentTask 单步执行','本轮 current 是 AgentTask','【显式重新准入】'];
export function intentEligible(packet){
  // Autonomy opportunities are host-scheduled reflection packets with no world observation.
  if(packet?.payload?.internal?.kind==='autonomy')
    return packet.stage==='reflection'&&packet.payload.current===undefined&&!packet.payload.task&&packet.payload.continuity?.subject?.id!==undefined;
  if(!DECISION_STAGES.includes(packet?.stage)||!packet.payload?.current||packet.payload?.task||!packet.payload?.continuity?.attention)return false;
  const suffix=packet.instructionSuffix??'';
  return !UNSUPPORTED_SUFFIX_MARKERS.some(m=>suffix.includes(m));
}

function parseHostFeedback(suffix){
  if(typeof suffix!=='string')return null;
  const marker='【宿主操作反馈】';const idx=suffix.indexOf(marker);
  if(idx===-1)return null;
  const rest=suffix.slice(idx+marker.length).split('\n\n')[0].trim();
  try{return JSON.parse(rest);}catch{return null;}
}

function toolView(name){
  const c=toolContract(name);if(!c)return {name};
  const props=c.inputSchema?.properties??{},required=c.inputSchema?.required??[];
  return {name,purpose:c.purpose,args:Object.fromEntries(Object.entries(props).map(([k,v])=>[k,(required.includes(k)?'必填 ':'')+(Array.isArray(v.type)?v.type.join('|'):v.type??'any')+(v.enum?' '+v.enum.join('/'):'')])),
    ...(c.sideEffect&&c.sideEffect!=='read'?{effect:c.sideEffect}:{})};
}

// Her own names, taken from the identity text ("你是某某…"), so the view can say whether a
// group message is addressed to her. Deterministic from the sealed packet.
export function selfNames(identity){
  const names=new Set();
  for(const m of String(identity??'').matchAll(/(?:你是|你叫|叫你|名字是|叫做)\s*[“"「]?([\p{Script=Han}A-Za-z0-9_]{1,12}?)[”"」]?(?=[，,。.！!、\s（(]|$)/gu))names.add(m[1]);
  return [...names];
}
// Who a chat message is aimed at: mentionsYou (her name or @name appears) and `to`
// (the message opens with @someone else). Only a hint; she can still join in.
function addressing(text,names,scene){
  const body=String(text??''),group=typeof scene==='string'&&/(^|\/)group[/:]/.test(scene);
  if(!group)return {chat:'private'};
  const mentionsYou=names.some(n=>body.includes(n));
  const lead=/^\s*@([^\s@，,：:]{1,20})/.exec(body)?.[1]??null;
  return {chat:'group',mentionsYou,...(lead&&!names.includes(lead)?{to:lead}:{})};
}
// The only model-visible capacity hint is the frozen sentence from attention.mjs; used/max
// stay host-side. W handles remain the subject's own desk directory: when the workspace is
// full the instruction states explicitly how she may drop one herself (no host chooses).
const CAPACITY_INSTRUCTION=ATTENTION_CAPACITY_HINT;
const RESIDENCE_REMOVE_GUIDE='工作区满时，可以从 view.attention 的 W 编号里选择一件旧事暂时放下：在输出最外层写 remove:["W1"]；只接受本轮 view.attention 实际给出的 W 编号，放下只解除驻留，不删除状态正文、版本或历史。';
function capacityFull(p){
  const rows=p.continuity?.attention?.residences??[],max=p.continuity?.maxForeground;
  return Number.isSafeInteger(max)&&rows.length>=max;
}
function residenceProjection(p,handles){
  if(!p.continuity?.attention)return null;
  const rows=p.continuity.attention.residences??[];
  const residences=rows.map((r,index)=>{
    const h='W'+(index+1);handles[h]={kind:'residence',ref:{id:r.id}};
    return {handle:h,target:r.target?.kind??null,cue:r.cue??null,delivery:r.delivery??null,purposes:[...new Set((r.purposes??[]).map(x=>x.kind))]};
  });
  return {residences};
}

// Deterministic translation of Limbic numerical drives/PAD/emotions into natural felt sense.
// Pure function of the sealed packet: no randomness, no host command, just readable bodily feel.
export function somaticFeel(motivation){
  const proj=motivation?.projection;
  if(!proj)return null;
  const feel=[],d=proj.drives??{},m=proj.mood??{};
  if(Number.isFinite(m.p)&&Number.isFinite(m.a)){
    if(m.p>=0.25&&m.a>=0.2)feel.push('此刻心情比较轻快，精力也挺活跃。');
    else if(m.p>=0.25&&m.a<=-0.2)feel.push('此刻心情安稳舒缓，挺享受安静的节奏。');
    else if(m.p<=-0.25&&m.a>=0.2)feel.push('心里有点烦躁或紧绷，不太能彻底静下来。');
    else if(m.p<=-0.25&&m.a<=-0.2)feel.push('情绪有点低落沉闷，提不起太多劲。');
  }
  if(Number.isFinite(d.sleepiness)&&d.sleepiness>=0.65)feel.push('有点困倦了，节奏自然放慢一点也挺好。');
  else if(Number.isFinite(d.fatigue)&&d.fatigue>=0.65)feel.push('感觉稍微有点累，不太想硬撑着做太重的事。');
  else if(Number.isFinite(d.fatigue)&&d.fatigue<=0.25&&(!Number.isFinite(d.sleepiness)||d.sleepiness<=0.3))feel.push('现在精力还不错，脑子比较清醒。');
  if(Number.isFinite(d.novelty)&&d.novelty>=0.62)feel.push('已经安静待了一阵，心里有点手痒，挺想找点新鲜事折腾、查点感兴趣的东西或立个小目标。');
  if(Number.isFinite(d.social)&&d.social>=0.62)feel.push('有点想找熟悉的人聊两句，看看对方近况或分享点小念头。');
  if(Number.isFinite(d.competence)&&d.competence>=0.62)feel.push('很想把手头的一件事推进扎实、做出点看得见的进展。');
  if(Number.isFinite(d.recognition)&&d.recognition>=0.65)feel.push('心里有点期待被看见、被回应的感觉。');
  const top=Object.values(proj.emotions??[]).filter(e=>Number.isFinite(e?.intensity)&&e.intensity>=0.2).sort((a,b)=>b.intensity-a.intensity).slice(0,2);
  if(top.length){
    feel.push('眼前最明显的情绪是：'+top.map(e=>`${e.name}${e.cause?`（因为${e.cause}）`:''}`).join('、')+'。');
  }
  return feel.length?feel.join(''):null;
}

function buildDeskCues({goals,work,states,tools,motivation}){
  const cues=[];
  const toolNames=new Set((tools??[]).map(t=>t.name));
  const dueGoal=(goals??[]).find(g=>g.due==='已到期');
  if(dueGoal)cues.push(`目标 ${dueGoal.handle}（「${String(dueGoal.goal).slice(0,28)}」）已经到期，可以推进、调整或收尾。`);
  else if((goals??[]).length)cues.push(`手头有 ${goals.length} 个未完成目标（如 ${goals[0].handle}），顺手可以推进一小步。`);
  if((work??[]).length)cues.push(`还有进行中的事务 ${work[0].handle}（「${String(work[0].title).slice(0,24)}」），可以看看要不要继续。`);
  const d=motivation?.projection?.drives??{};
  if(toolNames.has('bilibili_search')||toolNames.has('web_fetch')||toolNames.has('github_search')){
    cues.push((Number.isFinite(d.novelty)&&d.novelty>=0.55?'新鲜感正高：':'窗外是开着的：')+'可以用 bilibili_search / github_search / web_fetch 逛逛感兴趣的新话题，再把心得写进书桌或记成笔记。');
  }
  if(toolNames.has('office_write')||toolNames.has('office_list')){
    cues.push('你的独立书桌已就绪：可以用 office_list 翻翻旧稿，或用 office_write 写一篇小随笔、读书笔记或给对方留张纸条。');
  }
  if(toolNames.has('qq_minecraft')){
    cues.push('Minecraft 游乐场已开放：可以先用 qq_minecraft(action="status") 看看世界开没开，想玩就进去逛逛或建点东西。');
  }
  if(Number.isFinite(d.social)&&d.social>=0.58&&toolNames.has('proactive_contact')){
    cues.push('有点想找人说话：如果心里真有具体想聊的近况或刚逛到的好玩事，可以用 proactive_contact 主动发一句。');
  }
  if((states??[]).length>=3&&toolNames.has('remember_note')){
    cues.push('最近攒了几条零散认识，也可以顺手挑值得长留的用 remember_note 记成档案。');
  }
  return cues.slice(0,5);
}

// Deterministic projection for host-scheduled autonomy opportunities. There is no world
// event to answer; she sees her own goals, work, states and the tools she may use.
export function autonomyView(base,legacyPublic=false){
  const p=base.payload,c=p.continuity,handles={},view={};
  const home=homeView(p),clock=home?p.internal.now:p.now;
  const nowMs=Number.isSafeInteger(clock)?clock:null;
  if(p.identity)view.you=p.identity;
  if(p.style?.text)view.style=p.style.text;
  const lastAtAutonomy=Number.isSafeInteger(c.lastReaction?.at)?c.lastReaction.at:null;
  if(home)addHomeOrientation(view,p,nowMs,mergedView(p));
  else addTimeProjection(view,nowMs,lastAtAutonomy,!legacyPublic);
  if(p.internal?.focus)view.focus={kind:'due-continuation',ref:p.internal.focus,meaning:'fact-not-command'};
  if(p.internal?.kind)view.opportunity={kind:p.internal.opportunityType??'idle',...(p.internal.opportunity?{slot:p.internal.opportunity}:{})};
  view.mode='autonomy';view.canReply=false;
  let gi=0;const goals=[];
  for(const i of (c.intents??[]).slice(0,8)){
    if(!['open','pursuing','deferred'].includes(i.status))continue;
    const h='G'+(++gi);handles[h]={kind:'goal',ref:{id:i.id,revision:i.revision}};
    goals.push({handle:h,goal:i.goal??'',status:i.status,...(i.nextAction?{nextAction:i.nextAction}:{}),
      due:i.dueAt==null?null:(nowMs!==null&&i.dueAt<=nowMs?'已到期':new Date(i.dueAt).toISOString())});
  }
  if(goals.length)view.goals=goals;
  let pi=0;const work=[];
  const processes=[...(c.attention?.processes??[]),...(c.processes??[])];
  for(const t of processes.filter(x=>['active','proposed','paused'].includes(x.status)).slice(0,6)){
    const h='P'+(++pi);handles[h]={kind:'process',ref:{id:t.id,revision:t.revision}};
    work.push({handle:h,title:t.label??t.goal??'',status:t.status,step:t.stepCount??0});
  }
  if(work.length)view.work=work;
  let si=0;const states=[];
  for(const s of [...(c.foreground??[]),...(c.recalled??[])].slice(0,8)){
    const h='S'+(++si);handles[h]={kind:'state',ref:s.ref,stateKind:s.kind,...(s.mind===undefined?{}:{mind:s.mind})};
    states.push({handle:h,kind:s.kind,text:s.body??null,status:s.status??null});
  }
  if(states.length)view.states=states;
  let mi=0,materialBytes=0;const materials=[];
  for(const m of (p.materials??[]).slice(0,8)){
    const body=home?m.record?.body:m.body;
    if(home){
      const bytes=typeof body==='string'?Buffer.byteLength(body):0;
      if(!bytes||materialBytes+bytes>3000)continue;
      materialBytes+=bytes;
    }
    const h='M'+(++mi);handles[h]={kind:'material',ref:m.ref,aspects:m.aspects??[]};
    materials.push({handle:h,aspects:m.aspects??[],body:body??null});
  }
  if(materials.length)view.materials=materials;
  const emotions=Object.values(c.motivation?.projection?.emotions??[]).filter(e=>Number.isFinite(e?.intensity)&&e.intensity>0.05)
    .sort((a,b)=>b.intensity-a.intensity).slice(0,4).map(e=>({name:e.name,target:e.target??null,intensity:Math.round(e.intensity*100)/100,...(e.cause?{cause:e.cause}:{})}));
  if(!legacyPublic&&(!home||mergedView(p))&&emotions.length)view.mood=emotions;
  const felt=!home&&!legacyPublic?somaticFeel(c.motivation):null;
  if(felt)view.feltSense=felt;
  let ti=0;const tools=(p.allowedActionTools??[]).map(name=>({handle:'T'+(++ti),...toolView(name)}));
  if(tools.length)view.tools=tools;
  if(!legacyPublic){
    if(!home||mergedView(p)){
      const deskCues=buildDeskCues({goals,work,states,tools,motivation:c.motivation});
      if(deskCues.length)view.deskCues=deskCues;
    }else{
      const cues=[...new Set([...goals.filter(x=>x.nextAction),...goals])].slice(0,2)
        .map(x=>({handle:x.handle,...(x.nextAction?{next:x.nextAction}:{})}));
      for(const item of work){if(cues.length>=2)break;cues.push({handle:item.handle,status:item.status});}
      if(cues.length)view.deskCues=cues;
    }
  }
  const attention=residenceProjection(p,handles);if(attention)view.attention=attention;
  return {view,handles};
}
// Deterministic projection of a sealed base packet. Returns the model view and the handle table.
export function intentView(base,legacyPublic=false){
  if(base.payload?.internal?.kind==='autonomy')return autonomyView(base,legacyPublic);
  const p=base.payload,c=p.continuity,handles={E0:{kind:'event',ref:{id:p.current.id,revision:p.current.revision}}};
  const rich=richView(p),view={},nowMs=Number.isSafeInteger(p.now)?p.now:null,social=c.social??null;
  if(p.identity)view.you=p.identity;
  if(p.style?.text)view.style=p.style.text;
  const lastAtNormal=Number.isSafeInteger(c.lastReaction?.at)?c.lastReaction.at:(c.recent?.items?.length?c.recent.items.at(-1)?.at??null:null);
  if(homeView(p))addHomeOrientation(view,p,nowMs,mergedView(p));
  else addTimeProjection(view,nowMs,lastAtNormal,!legacyPublic);
  const cur=p.current;
  const curFrom=cur.origin==='tool_receipt'?'host':(social?.currentMeta?.senderName??resolveSpeakerName(null,{sender:cur.sender,actor:cur.actor}));
  const curAgo=social?.currentMeta?.ago??formatRelativeTime(cur.occurredAt??cur.recordedAt??null,nowMs);
  view.current={handle:'E0',from:curFrom,where:cur.scene??null,
    kind:cur.origin==='tool_receipt'?'tool-result':cur.origin==='observed'?'observation':'message',
    ...(curAgo?{ago:curAgo}:{}),
    ...(social?.currentMeta?.pendingInScene>0?{pendingInChat:social.currentMeta.pendingInScene}:{}),
    text:cur.body,
    ...(cur.origin==='tool_receipt'?{}:addressing(cur.body,selfNames(p.identity),cur.scene)),
    attachable:(c.attention.eventProcessSupport?.enabled===true)&&(c.attention.eventProcessSupport.events??[]).some(e=>e.id===cur.id&&e.revision===cur.revision),
    ...(cur.bodyDelivery?.fullBodyDelivered===false?{partial:`只交付了 ${cur.bodyDelivery.count}/${cur.bodyDelivery.total} 项`}:{})};
  if(social?.person)view.person=social.person;
  if(social?.elsewhere?.length)view.elsewhere=social.elsewhere;
  if(social?.recentTools?.length)view.recentTools=social.recentTools;
  const matById=new Map((p.materials??[]).map(m=>[m.ref?.id,m]));
  const recent=(c.recent?.items??[]).filter(i=>!(i.ref?.id===cur.id&&i.ref?.revision===cur.revision)).slice(-12)
    .map(i=>{
      const who=i.role==='user'?(i.senderName??resolveSpeakerName(null,{sender:i.sender,actor:i.actor})):(i.role==='assistant'||i.role==='her'?'你':i.role);
      const ago=formatRelativeTime(i.at??null,nowMs);
      const matBody=i.bodySource?.path==='materials'?matById.get(i.bodySource.ref?.id)?.record?.body:null;
      const bodyText=i.text??matBody??(i.bodySource?.path==='current'?'(见 current)':'(见上下文)');
      return {who,where:i.scene??null,...(ago?{ago}:{}),text:bodyText};
    });
  if(recent.length)view.recent=recent;
  const last=c.lastReaction;
  if(last){
    const lastAgo=formatRelativeTime(last.at??null,nowMs);
    view.lastAction={type:last.kind==='respond'?'reply':last.kind,...(last.utterance?{text:last.utterance}:{}),
      ...(last.responseStatus?{status:STATUS[last.responseStatus]??last.responseStatus}:{}),...(last.fromScene?{where:last.fromScene}:{}),...(lastAgo?{ago:lastAgo}:{})};
  }

  let n=0;const states=[],stateHandles=new Map();
  const memoryCards=[...(rich?c.shortTerm?.items??[]:[]),...(c.subjectiveMemory?.recent?.items??[]),...(c.subjectiveMemory?.compressed?.items??[])];
  const cards=[...(c.foreground??[]),...(c.recalled??[]),...memoryCards.map(m=>rich?{...m,kind:'impression',status:'open'}:m)];
  const seen=new Set();
  for(const s of cards){
    if(!s?.ref||s.historical||seen.has(s.ref.id))continue;seen.add(s.ref.id);
    const h='S'+(++n);handles[h]={kind:'state',ref:{id:s.ref.id,revision:s.ref.revision},stateKind:s.kind,...(rich&&s.mind?{mind:s.mind}:{})};
    stateHandles.set(canonical(handles[h].ref),h);
    const ago=formatRelativeTime(s.asOf??null,nowMs);
    states.push({handle:h,kind:s.kind,text:s.body,status:s.status,...(s.stage?{stage:s.stage}:{}),...(s.domains?.length?{domains:s.domains}:{}),...(ago?{ago}:{})});
  }
  if(states.length)view.states=states;
  if(rich){
    const asHandle=r=>stateHandles.get(canonical(r));
    for(const s of states){
      const m=handles[s.handle].mind;
      if(m)s.assessment={role:m.role,confidence:m.confidence,...(m.orientation||m.assessment?{stance:m.orientation??m.assessment}:{})};
    }
    const links=(c.mind?.links??[]).flatMap(l=>{
      const from=asHandle(l.from),to=asHandle(l.to);
      return from?[{from,...(to?{to}:{}),relation:l.relation,status:l.status}]:[];
    }).slice(0,12);
    const expectations=(c.mind?.expectations??[]).flatMap(e=>{
      const h=asHandle(e.ref);
      return h?[{state:h,condition:e.value,execution:e.executionStatus}]:[];
    }).slice(0,4);
    if(links.length||expectations.length)view.judgments={links,expectations};
  }
  if(c.subjectiveMemory&&((c.subjectiveMemory.recent?.omitted??0)>0||(c.subjectiveMemory.compressed?.count??0)>0)){
    view.memoryStats={recentCount:c.subjectiveMemory.recent?.count??0,compressedCount:c.subjectiveMemory.compressed?.count??0,
      ...(c.subjectiveMemory.recent?.omitted>0?{omittedRecent:c.subjectiveMemory.recent.omitted}:{}),
      ...(c.subjectiveMemory.compressed?.omitted>0?{omittedCompressed:c.subjectiveMemory.compressed.omitted}:{}),
      note:'完整主观记忆与压缩主题单元见 states；被省略条目可用 lookup 检索'};
  }
  if(c.mind?.unresolved?.length)view.unresolved=c.mind.unresolved.slice(0,6);
  if(c.intents?.length){
    view.goals=c.intents.slice(0,6).map((x,i)=>{
      const h='G'+(i+1);
      if(rich)handles[h]={kind:'goal',ref:{id:x.id,revision:x.revision}};
      return {...(rich?{handle:h}:{}),goal:x.goal,status:x.status,...(x.nextAction?{nextAction:x.nextAction}:{}),...(x.dueAt?{dueIn:formatRelativeTime(x.dueAt,nowMs)}:{})};
    });
  }
  if(p.previousDecisions?.length){
    const curPrivId=typeof cur.scene==='string'&&cur.scene.startsWith('qq/private/')?cur.scene.slice('qq/private/'.length):null;
    const sameContext=d=>{
      const dScene=d.origin?.scene;
      if(typeof dScene==='string'&&dScene.startsWith('qq/private/')){
        return curPrivId!==null&&dScene.slice('qq/private/'.length)===curPrivId;
      }
      const evId=d.origin?.currentEvent?.id;
      if(typeof evId!=='string'||!evId.startsWith('obs:private:'))return true;
      const parts=evId.split(':');
      return curPrivId!==null&&parts[2]===curPrivId;
    };
    const steps=p.previousDecisions.filter(sameContext).slice(-2).map(d=>({selected:d.selected?.kind??null,summary:d.summary}));
    if(steps.length)view.priorSteps=steps;
  }

  const threads=c.threads??{},summaries=new Map([[threads.foreground?.id,threads.foreground],...(threads.background??[]).map(t=>[t.id,t])]);
  n=0;const work=[];
  for(const proc of c.attention.processes??[]){
    if(['completed','abandoned'].includes(proc.status))continue;
    const h='P'+(++n);handles[h]={kind:'process',ref:{id:proc.id,revision:proc.revision},process:proc};
    const t=summaries.get(proc.id),units=t?.history?.units??t?.units??[];
    const history=units.slice(-4).map(u=>{
      const uAgo=formatRelativeTime(u.incoming?.at??u.at??null,nowMs);
      if(rich&&u.kind==='task-execution-evidence'){
        const visibleScene=scene=>!scene?.startsWith('qq/private/')||scene===cur.scene;
        if(!visibleScene(u.sourceScene)||!visibleScene(u.incoming?.scene))return {kind:'task-history',withheld:true};
        const evidence=u.evidence.filter(e=>['result','observation'].includes(e.role)&&visibleScene(e.scene));
        return {kind:'task-history',goal:u.goal,status:u.status,...(uAgo?{ago:uAgo}:{}),
          ...(evidence.length>3?{omittedEvidence:evidence.length-3}:{}),
          evidence:evidence.slice(-3).map(e=>({kind:e.role,origin:e.origin,excerpt:e.body.slice(0,400),
            partial:e.body.length>400||e.completeness?.truncated===true,...(e.statusAtRecord?{status:e.statusAtRecord}:{}),...(e.historical?{historical:true}:{})}))};
      }
      return {...(uAgo?{ago:uAgo}:{}),...(u.incoming?{incoming:u.incoming.body}:{}),
        ...(u.exchanges??[]).slice(-1).reduce((a,x)=>({...a,...(x.response?{you:x.response.body,status:STATUS[x.response.status]??x.response.status}:{}),
          ...(x.action?{action:x.action.tool??x.action.kind??'action'}:{}),...(x.receipt?{result:String(x.receipt.body??x.receipt.status??'').slice(0,300)}:{})}),{})};
    });
    const lastUnitAt=units.at(-1)?.incoming?.at??units.at(-1)?.at??proc.updatedAt??proc.recordedAt??null;
    const updatedAgo=formatRelativeTime(lastUnitAt,nowMs);
    work.push({handle:h,title:proc.label,status:proc.status,...(updatedAgo?{updatedAgo}:{}),...(t?.summary?{note:t.summary}:{}),...(history.length?{history}:{})});
  }
  if(work.length)view.work=work;

  const emotions=Object.values(c.motivation?.projection?.emotions??[]).filter(e=>Number.isFinite(e?.intensity)&&e.intensity>0.05)
    .sort((a,b)=>b.intensity-a.intensity).slice(0,4).map(e=>({name:e.name,target:e.target??null,intensity:Math.round(e.intensity*100)/100,...(rich&&e.cause?{cause:e.cause}:{})}));
  if(emotions.length)view.mood=emotions;
  const felt=!homeView(p)&&!legacyPublic?somaticFeel(c.motivation):null;
  if(felt)view.feltSense=felt;
  if(rich&&p.apperceptionV1?.enabled===true)view.canInterpret=true;
  if(p.apperceptionV1?.enabled===true&&c.motivation?.canAppraiseCurrent===true)view.canEvaluateMood=true;
  const fb=parseHostFeedback(base.instructionSuffix);
  if(fb?.recentFeedback?.length){
    const safeFb=fb.recentFeedback
      .filter(x=>x.kind!=='input-feedback'||pagedLookup(p)&&x.sameConversation&&x.stage==='validation')
      .slice(0,3)
      .map(x=>({
        kind:x.kind,
        ...(x.adopted!==undefined?{adopted:x.adopted}:{}),
        ...(x.error?{error:x.error}:{}),
        ...(x.kind==='input-feedback'&&x.details?.path?{field:x.details.path}:{}),
        ...(x.tool?{tool:x.tool,outcome:x.outcome}:{}),
      }));
    if(safeFb.length)view.hostFeedback=safeFb;
  }
  if(fb?.policy?.externalSend)view.sendScope=fb.policy.externalSend;

  n=0;const materials=[];
  for(const m of p.materials??[]){
    const h='M'+(++n);handles[h]={kind:'material',ref:m.ref,aspects:m.aspects};
    materials.push({handle:h,type:m.record?.type??null,text:m.record?.body??null,...(m.historical?{historical:true}:{}),
      ...(homeView(p)&&m.reminder?{from:m.reminder==='pinboard'?'床头本':m.record.type==='event'?'想起的经历':'想起的旧笔记',
        ...(m.record.kind?{kind:m.record.kind}:{}),...(m.record.confidence?{confidence:m.record.confidence}:{})}:{})});
  }
  if(materials.length)view.materials=materials;
  n=0;const reminders=[],reminderById=new Map();
  const addReminder=(ref,hint,historical=false)=>{
    if(!ref||materials.some(m=>handles[m.handle].ref.id===ref.id))return materials.find(m=>handles[m.handle].ref.id===ref.id)?.handle??null;
    if(reminderById.has(ref.id))return reminderById.get(ref.id);
    const h='R'+(++n);handles[h]={kind:'reminder',ref:{id:ref.id,revision:ref.revision}};reminderById.set(ref.id,h);
    reminders.push({handle:h,hint,...(historical?{historical:true}:{})});
    return h;
  };
  for(const a of c.attention.associationCandidates??[])addReminder(a?.ref,a?.label,Boolean(a?.historical));
  if(c.anchors?.records?.length){
    const anchors=[];
    for(const a of c.anchors.records.slice(0,8)){
      const rType=a.recordType??a.type??null;
      const handle=rType==='note'?addReminder(a.ref,`[锚点笔记 ${a.anchor?.kind??'anchor'}/${a.kind??'note'}]`,Boolean(a.historical)):null;
      const ago=formatRelativeTime(a.asOf??null,nowMs);
      anchors.push({...(handle?{handle}:{}),type:rType,kind:a.kind??null,...(a.domains?.length?{domains:a.domains}:{}),...(ago?{ago}:{}),...(a.historical?{historical:true}:{})});
    }
    if(anchors.length)view.anchors=anchors;
  }
  if(p.experienceLearning?.enabled&&p.experienceLearning.directory?.length){
    view.lessons=p.experienceLearning.directory.slice(0,4).map(l=>{
      const handle=addReminder(l.ref,`[经验] ${String(l.lesson??'').slice(0,60)}`,false);
      return {...(handle?{handle}:{}),lesson:l.lesson,conditions:l.conditions,scope:l.scope,status:l.status};
    });
  }
  if(reminders.length)view.reminders=reminders;
  const info=p.information?.results??[];
  const remaining=p.memoryAccess?.remainingReads??0;
  view.lookup={remaining};
  if(info.length&&pagedLookup(p)){
    const delivered=new Set((p.materials??[]).map(m=>refKey(m.ref)));
    delivered.add(refKey(p.current));
    const stateBodies=new Set([...(c.foreground??[]),...(c.recalled??[])].map(s=>refKey(s.ref)));
    view.lookup.done=info.map((r,i)=>{
      const entries=r.entries??[],readable=entries.filter(e=>['event','note'].includes(e.type));
      const stateRefs=p.intentProtocol?.format==='intent-base-v5'?(r.states??[]):[];
      const bodies=readable.filter(e=>delivered.has(refKey(e.ref))).length+stateRefs.filter(e=>stateBodies.has(refKey(e.ref))).length;
      const found=entries.length+stateRefs.length;
      const more=r.nextPage&&remaining>0&&r.outcome==='found'?'L'+(i+1):null;
      if(more)handles[more]={kind:'lookup-page',ref:r.nextPage};
      return {status:r.outcome,found,delivered:bodies,total:r.total??null,
        partial:Boolean(r.nextPage)||bodies<found||!['found','empty','not-found'].includes(r.outcome),
        ...(more?{more}:{})};
    });
  }else if(info.length){
    view.lookup.done=info.map(r=>({status:r.status??r.outcome??null,found:r.hits?.length??r.found??null}));
  }
  n=0;const tools=(p.allowedActionTools??[]).map(name=>({handle:'T'+(++n),...toolView(name)}));
  if(tools.length)view.tools=tools;
  const attention=residenceProjection(p,handles);if(attention)view.attention=attention;
  return {view,handles};
}

export function intentPacket(base,prompts=PROMPTS.current,legacyPublic=false){
  verifiedModelInput(base);
  ensure(intentEligible(base),'INTENT_PROFILE','packet is not an ordinary event decision');
  const autonomy=base.payload?.internal?.kind==='autonomy';
  const {view,handles}=intentView(base,legacyPublic);
  const capacityInstruction=Object.hasOwn(view,'attention')&&capacityFull(base.payload)?'\n\n'+CAPACITY_INSTRUCTION+'\n'+RESIDENCE_REMOVE_GUIDE:'';
  const home=homeView(base.payload);
  const AUTONOMY_INSTRUCTION=legacyPublic||home&&!mergedView(base.payload)?LEGACY_AUTONOMY_INSTRUCTION:ZIP_AUTONOMY_INSTRUCTION;
  if(home)ensure(typeof prompts.home==='string','PACKET_STAGE','home prompt required');
  const nextPage=pagedLookup(base.payload)&&view.lookup?.done?.length?'\n\n查阅结果在 lookup.done。found 是这页匹配数，delivered 是交付正文数，partial 表示还有页面、正文省略或查询未完成。若有 more（如 L1），可以用 lookup 的 open 打开下一页。':'';
  const instruction=(home?prompts.home:prompts.intent)+(home?'':(richView(base.payload)?'\n\n'+MIND_INPUT:'')+(autonomy?'\n\n'+AUTONOMY_INSTRUCTION:''))
    +nextPage
    +capacityInstruction+(base.payload.style?.text?'\n\n'+prompts.anti:'');
  const packetId=digest({stage:INTENT_STAGE,instruction,basePacketId:base.packetId,view});
  const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,view})}];
  const bytes=Buffer.byteLength(canonical(messages),'utf8');
  // Autonomy packets carry unified tools, feltSense, timeFeel and deskCues;
  // keep a bounded 48KB ceiling so full capabilities never overflow.
  const limit=autonomy?Math.min(base.budgetBytes,legacyPublic||home&&!mergedView(base.payload)?16384:49152):base.budgetBytes;
  ensure(bytes<=limit,'INPUT_OVERFLOW','intent packet exceeds budget');
  return {stage:INTENT_STAGE,packetId,basePacket:base,instruction,messages,bytes,budgetBytes:base.budgetBytes,handles};
}
export function verifiedIntent(wire){
  ensure(wire?.stage===INTENT_STAGE,'PACKET_STAGE','not an intent packet');
  ensure(intentWireFor(wire.basePacket,wire.packetId,wire),'PACKET_CHANGED','intent packet changed');
  return {packetId:wire.packetId,messages:wire.messages,bytes:wire.bytes};
}

const handle=(wire,h,kind,path)=>{const v=wire.handles[h];if(!v||v.kind!==kind)fail('INTENT_HANDLE',`${path}: “${h}” 不是本轮 view 里的${{state:'状态 S',process:'工作 P',goal:'目标 G',material:'材料 M',residence:'驻留 W'}[kind]}编号`,{path,handle:h,expected:kind});return v;};

// Compile model intent into the ordinary full output object. Throws ContractError on
// anything ambiguous; never guesses meaning.
export function expandIntent(wire,raw,{store=null,diagnostics=[]}={}){
  verifiedIntent(wire);
  ensure(typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=32768,'OUTPUT_LIMIT','bounded JSON required');
  let o;try{o=JSON.parse(raw);}catch{fail('OUTPUT_JSON','output is not valid JSON');}
  ensure(plain(o),'INTENT_SHAPE','output must be a JSON object');
  ensure(o.packetId===wire.packetId,'WRONG_PACKET','packetId must be copied from this input');
  const base=wire.basePacket,p=base.payload,subject=p.continuity.subject.id,current=wire.handles.E0?.ref??null,rich=richView(p),autonomy=p.internal?.kind==='autonomy';
  // Explicit desk removals are delivered W handles only; a residence id is never invented.
  const requestedRemove=o.remove===undefined?[]:o.remove;
  ensure(Array.isArray(requestedRemove)&&requestedRemove.length<=8,'INTENT_LIMIT','remove: at most 8 delivered residence handles');
  const removeIds=[];
  for(const [i,h] of requestedRemove.entries()){const t=handle(wire,h,'residence',`remove[${i}]`);if(!removeIds.includes(t.ref.id))removeIds.push(t.ref.id);}
  const salt=k=>digest({packet:base.packetId,k});
  // Process bodies are not in the catalog; read them from the exact delivered frame version.
  const frameRef=p.continuity.attention.frame,frame=store&&frameRef?store.read(frameRef.id,frameRef.revision):null;
  const bodyOf=proc=>frame?.processes?.find(x=>x.id===proc.id&&x.revision===proc.revision)?.body??null;

  // decision
  const d=o.decision;ensure(plain(d)&&typeof d.type==='string','INTENT_SHAPE','decision.type required');
  let option;
  switch(d.type){
    case 'reply':
      ensure(!autonomy,'REPLY_NOT_ALLOWED','autonomy opportunities cannot send replies');
      option={kind:'respond',payload:{text:str(d.text,'decision.text',2000)}};break;
    case 'act':{
      ensure(typeof d.tool==='string'&&(p.allowedActionTools??[]).includes(d.tool),'TOOL_NOT_GRANTED',`tool “${d.tool}” is not in view.tools`,{tool:d.tool});
      ensure(d.args===undefined||plain(d.args),'INTENT_SHAPE','decision.args must be an object');
      const args={...d.args};
      if((rich||autonomy)&&d.tool==='start_agent_task'){
        for(const [field,kind,prefix] of [['processId','process','P'],['intentId','goal','G']]){
          if(typeof args[field]==='string'&&new RegExp('^'+prefix+'[0-9]+$').test(args[field]))
            args[field]=handle(wire,args[field],kind,'decision.args.'+field).ref.id;
        }
      }
      option={kind:'act',payload:{tool:d.tool,args}};break;}
    case 'lookup':
      if(d.open!==undefined){
        if(pagedLookup(p))ensure(typeof d.open==='string','INTENT_SHAPE','decision.open needs one delivered handle',{path:'decision.open'});
        const t=wire.handles[d.open],page=t?.kind==='lookup-page';
        ensure(t&&(['material','reminder'].includes(t.kind)||page),
          'INTENT_HANDLE',`decision.open: “${d.open}” 不是本轮 view 里的可打开编号`,{path:'decision.open',handle:d.open});
        option={kind:'lookup',payload:page?{pageAfter:t.ref}:{ref:t.ref}};
      }
      else{ensure(Array.isArray(d.terms)&&d.terms.length>0&&d.terms.length<=8,'INTENT_SHAPE','lookup needs 1-8 terms or open');d.terms.forEach((t,i)=>str(t,`decision.terms[${i}]`,80));option={kind:'lookup',payload:{terms:d.terms}};}
      break;
    case 'intent':{
      ensure(autonomy,'INTENT_SHAPE','intent decisions are only available in autonomy opportunities');
      const payload={};
      if(d.handle!==undefined)payload.intentId=handle(wire,d.handle,'goal','decision.handle').ref.id;
      if(d.goal!==undefined)payload.goal=str(d.goal,'decision.goal',600);
      if(d.rationale!==undefined)payload.rationale=str(d.rationale,'decision.rationale',600);
      if(d.nextAction!==undefined)payload.nextAction=str(d.nextAction,'decision.nextAction',600);
      if(d.dueAt!==undefined){ensure(Number.isSafeInteger(d.dueAt),'INTENT_SHAPE','decision.dueAt must be an integer');payload.dueAt=d.dueAt;}
      if(d.status!==undefined){ensure(['open','pursuing','deferred','completed','abandoned','expired'].includes(d.status),'INTENT_SHAPE','invalid intent status');payload.status=d.status;}
      ensure(payload.intentId!==undefined||payload.goal!==undefined,'INTENT_SHAPE','new intent needs a goal');
      option={kind:'intent',payload};break;}
    case 'wait':case 'pause':case 'continue':option={kind:d.type,payload:{}};break;
    case 'none':option={kind:'none',payload:{}};break;
    default:fail('INTENT_SHAPE',`unknown decision.type “${d.type}”`);
  }

  // Fast-brain shorthand: optional `memo` (string or string[]) lets the model jot down
  // raw notes during chat without worrying about taxonomy; slow-brain consolidates later.
  // states → continuity.changes (+ residency so kept states stay in view)
  const states=autonomy?[]:(o.states??[]);
  if(autonomy&&o.states!==undefined)diagnostics.push({path:'states',code:'AUTONOMY_STATES_IGNORED',reason:'no world observation to base a personal-state change on'});
  ensure(Array.isArray(states)&&states.length<=8,'INTENT_LIMIT','states: at most 8');
  const memo=autonomy||o.memo===undefined?[]:(Array.isArray(o.memo)?o.memo:[o.memo]);
  const lines=homeView(p)?memo.map((line,i)=>str(line,`memo[${i}]`,400))
    :memo.filter(line=>typeof line==='string'&&line.trim()).slice(0,4).map(line=>line.trim().slice(0,400));
  ensure(lines.length<=4&&lines.length+states.length<=8,'INTENT_LIMIT','memo: at most 4 lines, at most 8 combined with states');
  const entries=[...states,...lines.map(text=>({kind:'impression',text,keep:false}))];
  const changes=[],keep=[],residences=p.continuity.attention.residences??[];
  const delivered=deliveredStateRefs(p.continuity);
  for(const [i,s] of entries.entries()){
    const path=`states[${i}]`;ensure(plain(s),'INTENT_SHAPE',`${path} must be an object`);
    ensure(Object.keys(s).every(k=>['update','kind','text','status','keep',...(rich?['domains','stance','confidence','links']:[])].includes(k)),'INTENT_SHAPE',`${path}: unsupported state field`);
    const previous=s.update!==undefined?handle(wire,s.update,'state',path+'.update'):null;
    const kind=previous?.stateKind??s.kind,prior=previous?.mind;
    const semantic={};
    if(s.domains!==undefined)semantic.domains=normalizeDomains(s.domains);
    if(s.links!==undefined||kind==='readiness'&&(s.confidence!==undefined||!previous)){
      ensure(kind==='readiness'&&s.stance===undefined,'INTENT_SHAPE',`${path}: links are only for readiness`);
      const confidence=s.confidence??prior?.confidence??'tentative';
      ensure(['tentative','uncertain','confident'].includes(confidence),'INTENT_SHAPE',`${path}: invalid confidence`);
      semantic.mind={...prior,role:'readiness',confidence};
      if(s.links!==undefined){
        ensure(Array.isArray(s.links)&&s.links.length>0&&s.links.length<=8,'INTENT_LIMIT',`${path}: link 1–8 delivered judgments`);
        for(const key of Object.values(READINESS_LINKS))semantic.mind[key]=[];
        for(const h of s.links){
          const target=handle(wire,h,'state',path+'.links'),kind=target.mind?.role;
          ensure(Object.hasOwn(READINESS_LINKS,kind),'INTENT_HANDLE',`${path}: link only delivered beliefs, concerns, conditions or expectations`);
          semantic.mind[READINESS_LINKS[kind]].push(target.ref);
        }
      }else ensure(prior,'INTENT_SHAPE',`${path}: new readiness needs delivered links`);
    }else if(s.stance!==undefined||s.confidence!==undefined||rich&&!previous&&Object.hasOwn(MIND_CHOICES,kind)){
      ensure(['appraisal','concern','condition'].includes(kind),'INTENT_SHAPE',`${path}: stance/confidence require appraisal, concern or condition`);
      ensure(!prior||['belief','concern','condition'].includes(prior.role),'INTENT_SHAPE',`${path}: cannot change this judgment through a simple stance`);
      const confidence=s.confidence??prior?.confidence??'tentative';
      ensure(['tentative','uncertain','confident'].includes(confidence),'INTENT_SHAPE',`${path}: invalid confidence`);
      semantic.mind={...prior,role:kind==='appraisal'?'belief':kind,confidence};
      if(kind==='appraisal')ensure(s.stance===undefined,'INTENT_SHAPE',`${path}: appraisal has no stance`);
      else{
        const field=kind==='concern'?'orientation':'assessment',stance=s.stance??prior?.[field];
        ensure(MIND_CHOICES[kind].includes(stance),'INTENT_SHAPE',`${path}: give a valid stance for ${kind}`);
        semantic.mind[field]=stance;
      }
    }
    if(s.status!==undefined)ensure(['open','closed'].includes(s.status),'INTENT_SHAPE',`${path}.status must be open or closed`);
    if(s.update!==undefined){
      const t=previous;
      ensure(s.kind===undefined||s.kind===t.stateKind,'STATE_IDENTITY',`${path}: kind of ${s.update} cannot change; write a new state instead`);
      ensure(s.text!==undefined||s.status!==undefined||Object.keys(semantic).length,'INTENT_SHAPE',`${path}: give text, status or a judgment change`);
      changes.push({id:t.ref.id,nature:'reappraisal',...(s.text!==undefined?{body:str(s.text,path+'.text',2048)}:{}),...(s.status?{status:s.status}:{}),...(rich?{expectedRevision:t.ref.revision}:{}),
        basis:{observations:[current],priorStates:[t.ref],memories:[]},...semantic});
      if(s.keep!==false&&s.status!=='closed'&&(!rich||t.stateKind!=='impression'))keep.push({id:t.ref.id,revision:(rich?t.ref.revision:Math.max(t.ref.revision,...delivered.filter(r=>r.id===t.ref.id).map(r=>r.revision)))+1,cue:s.text??null});
      // keep:false releases only the autogenerated residence of this state (no-op if absent).
      if(s.keep===false){const auto=`residence:${t.ref.id}`;if(residences.some(r=>r.id===auto)&&!removeIds.includes(auto))removeIds.push(auto);}
    }else{
      ensure(STATE_KINDS.includes(s.kind)||rich&&(s.kind==='readiness'||Object.hasOwn(MIND_CHOICES,s.kind)),'INTENT_SHAPE',`${path}.kind must be one of ${STATE_KINDS.join('/')}`);
      const id=`state:${subject}:${s.kind}:${salt('state'+i)}`;
      const scene=rich&&s.kind==='impression'?(p.continuity.eventAbout??[]).find(r=>r.kind==='scene'&&r.id===p.current.scene):null;
      if(scene)semantic.about=[scene];
      changes.push({id,kind:s.kind,...(rich?{expectedRevision:0}:{}),body:str(s.text,path+'.text',2048),status:s.status??'open',nature:'encounter',basis:{observations:[current],priorStates:[],memories:[]},...semantic});
      if(s.keep!==false&&s.status!=='closed'&&s.kind!=='impression')keep.push({id,revision:1,cue:s.text});
    }
  }

  // work → attention.processes and explicit event→process links
  const work=autonomy?[]:(o.work??[]);
  if(autonomy&&o.work!==undefined)diagnostics.push({path:'work',code:'AUTONOMY_WORK_IGNORED',reason:'task and process work are started by act, not written here'});
  ensure(Array.isArray(work)&&work.length<=4,'INTENT_LIMIT','work: at most 4');
  const processes=[],links=[];
  const events=p.continuity.attention.eventProcessSupport?.enabled?p.continuity.attention.eventProcessSupport.events??[]:null;
  for(const [i,w] of work.entries()){
    const path=`work[${i}]`;ensure(plain(w),'INTENT_SHAPE',`${path} must be an object`);
    ensure(Object.keys(w).every(k=>['update','title','note','status','thisMessage'].includes(k)),'INTENT_SHAPE',`${path}: only update/title/note/status/thisMessage`);
    if(w.status!==undefined)ensure(WORK_STATUS.includes(w.status),'INTENT_SHAPE',`${path}.status must be ${WORK_STATUS.join('/')}`);
    let target;
    if(w.update!==undefined){
      const t=handle(wire,w.update,'process',path+'.update'),old=t.process;
      const touched=w.title!==undefined||w.note!==undefined||w.status!==undefined,oldBody=bodyOf(old);
      if(touched)ensure(w.note!==undefined||oldBody!==null,'INTENT_SHAPE',`${path}: ${w.update} 的原内容本轮未交付，修改时请同时写 note`);
      if(touched)processes.push({id:old.id,label:w.title!==undefined?str(w.title,path+'.title',100):old.label,
        body:w.note!==undefined?str(w.note,path+'.note',1024):oldBody,status:w.status??old.status,world:old.world,intervals:old.intervals??[],basis:[current]});
      target={id:old.id,revision:old.revision};
    }else{
      const id=`process:${subject}:${salt('work'+i)}`;
      processes.push({id,label:str(w.title,path+'.title',100),body:w.note!==undefined?str(w.note,path+'.note',1024):w.title,status:w.status??'active',world:'actual',intervals:[],basis:[current]});
      target={id,revision:1};
    }
    if(w.thisMessage===true){
      // Only admitted incoming messages can be attached; a tool result already joins its work
      // through the action→receipt chain. Not recordable here, so note it instead of failing the turn.
      if(events&&events.some(e=>e.id===current.id&&e.revision===current.revision))links.push({event:current,process:target});
      else diagnostics.push({path:path+'.thisMessage',code:'NOT_ATTACHABLE_IGNORED',reason:'current is not an attachable incoming message'});
    }
  }

  // used
  if(o.used!==undefined&&!Array.isArray(o.used)){diagnostics.push({path:'used',code:'USED_NOT_A_LIST_IGNORED'});o.used=[];}
  // used is a declaration, not a state change: only delivered materials (M) count. Any other
  // entry (the current item, a tool, an unopened reminder, a handle that does not exist) is
  // noted and left out; it never discards the turn. Handles in decision/states/work stay strict.
  const used=[];
  for(const [i,h] of (o.used??[]).entries()){
    const t=wire.handles[h];
    if(t?.kind==='material'&&!used.some(u=>u.ref.id===t.ref.id))used.push({ref:t.ref,aspect:t.aspects[0],effect:'context'});
    else diagnostics.push({path:`used[${i}]`,code:h==='E0'?'CURRENT_NOT_A_MATERIAL_IGNORED':'NOT_A_MATERIAL_IGNORED',handle:h});
  }

  const keepRows=keep.filter(k=>{const residenceId=`residence:${k.id}`;
    if(removeIds.includes(residenceId)){diagnostics.push({path:'states',code:'KEEP_CANCELLED_BY_REMOVE',state:k.id,residence:residenceId});return false;}
    return true;});
  // One autogenerated residence per kept state. A full-protocol residence that happens to share
  // the same target is never reused or overwritten here; explicit W removal is the only way to
  // release such a residence. keep:false only affects the autogenerated binding.
  const upsert=keepRows.map(k=>{const residenceId=`residence:${k.id}`,old=residences.find(r=>r.id===residenceId);
    return {id:residenceId,target:{kind:'state',ref:{id:k.id,revision:k.revision}},cue:[...(k.cue??old?.cue??'')].slice(0,160).join('')||'自己的状态',
      purposes:[{kind:'active-task',eventIds:[],questionId:null,appliesTo:null}]};});
  const attention={...keepAttention(),processes,residency:{upsert,remove:removeIds},...(links.length?{eventProcesses:{add:links,remove:[]}}:{})};
  const summary=typeof o.summary==='string'&&o.summary.trim()?[...o.summary].slice(0,400).join(''):'模型未提供简短说明（宿主标记）';

  let apperception,affectAppraisal;
  if(autonomy&&o.perception!==undefined)diagnostics.push({path:'perception',code:'AUTONOMY_PERCEPTION_IGNORED',reason:'no current world observation in an autonomy opportunity'});
  if(rich&&o.perception!==undefined&&current){
    const v=o.perception;
    ensure(p.apperceptionV1?.enabled===true&&plain(v)&&Object.keys(v).every(k=>['domain','meaning'].includes(k)),'INTENT_SHAPE','perception needs enabled apperception and domain/meaning');
    const meaning=str(v.meaning,'perception.meaning',300);
    apperception={schema_version:'apperception.slice.v1',activated_cells:[{domain:v.domain,perspective:'meaning',content:meaning,epistemic_status:'interpretation',source_refs:[current],uncertainty:null}],integrated_understanding:meaning};
  }
  if(autonomy&&o.moodEval!==undefined)diagnostics.push({path:'moodEval',code:'AUTONOMY_MOOD_IGNORED',reason:'no current encounter to appraise'});
  if(o.moodEval!==undefined&&o.moodEval!==null&&current){
    ensure(plain(o.moodEval),'INTENT_SHAPE','moodEval must be an object');
    const m=o.moodEval;
    const meaning=str(m.meaning,'moodEval.meaning',300);
    const evLabel=m.event!==undefined?str(m.event,'moodEval.event',80):'chat';
    const valence=m.valence??0,intensity=m.intensity??0.3,agency=m.agency??'other';
    ensure(typeof valence==='number'&&Number.isFinite(valence)&&valence>=-1&&valence<=1,'INTENT_SHAPE','moodEval.valence must be -1..1');
    ensure(typeof intensity==='number'&&Number.isFinite(intensity)&&intensity>=0&&intensity<=1,'INTENT_SHAPE','moodEval.intensity must be 0..1');
    ensure(['self','other','circumstance'].includes(agency),'INTENT_SHAPE','moodEval.agency must be self/other/circumstance');
    if(p.apperceptionV1?.enabled===true){
      apperception??={schema_version:'apperception.slice.v1',activated_cells:[{domain:p.continuity.social?.person?'relationship':'self',perspective:'meaning',content:meaning,epistemic_status:'interpretation',source_refs:[current],uncertainty:null}],integrated_understanding:meaning};
      if(p.continuity.motivation?.canAppraiseCurrent===true){
        affectAppraisal={schema_version:'affect.appraisal.v2',mode:'encounter',source_refs:[current],reason:summary,
          appraisals:[{weight:1,value:{event:evLabel,summary:meaning,valence,intensity,relevance:Math.max(0.2,intensity),agency,target:p.continuity.social?.person?.who?.id??null}}]};
      }
    }else{
      diagnostics.push({path:'moodEval',code:'MOOD_EVAL_IGNORED',reason:'apperception/affect not enabled for this packet'});
    }
  }

  // Reflection packets use the narrower continuity shape: no expression choice or
  // observation disposition, and an explicit attention keep when one was delivered.
  const reflection=base.stage==='reflection';
  return {packetId:base.packetId,options:[{id:'chosen',...option}],selected:'chosen',summary,used,
    ...(apperception?{apperception}:{}),...(affectAppraisal?{affectAppraisal}:{}),
    continuity:{changes,residency:{add:[],remove:[]},
      ...(reflection?{}:{expressionChoice:null,observationDisposition:'handled'}),
      ...(p.continuity.attention?{attention}:{})}};
}

// The wire a given intent output answered: any known prompt generation whose packetId matches.
export function intentWireFor(base,packetId,expected=null){
  const projections=homeView(base?.payload??{})?[false]:[false,true];
  for(const legacyPublic of projections)for(const prompts of PROMPTS.all()){
    let w;try{w=intentPacket(base,prompts,legacyPublic);}catch{continue;}
    if(w.packetId===packetId&&(!expected||canonical(w)===canonical(expected)))return w;
  }
  return null;
}
// An intent answer is recognised by shape: it has a decision and no full-protocol options.
export function looksLikeIntent(raw){
  let o;try{o=typeof raw==='string'?JSON.parse(raw):raw;}catch{return false;}
  return plain(o)&&Object.hasOwn(o,'decision')&&!Object.hasOwn(o,'options');
}
// Format check used by transport for the one mechanical recovery attempt.
export function intentFormatIssue(raw,wire){
  let o;try{o=JSON.parse(raw);}catch(e){return {code:'OUTPUT_JSON',path:'output',message:String(e.message).slice(0,240)};}
  if(!plain(o))return {code:'OUTPUT_ENVELOPE',path:'output',message:'需要JSON对象'};
  if(o.packetId!==wire.packetId)return {code:'OUTPUT_ENVELOPE',path:'packetId',message:'必须与本轮输入packetId一致'};
  if(!plain(o.decision)||typeof o.decision.type!=='string')return {code:'OUTPUT_ENVELOPE',path:'decision',message:'需要decision对象及type'};
  return null;
}
