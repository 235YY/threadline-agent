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
import {canonical,digest,ensure} from './contracts.mjs';
import {verifiedModelInput} from './cognition.mjs';
import {keepAttention} from './attention.mjs';
import {toolContract} from './tool-contracts.mjs';
import {generationSets} from './prompt-generations.mjs';
import {deliveredStateRefs} from './revision-derivation.mjs';
import {formatRelativeTime,resolveSpeakerName} from './social-projection.mjs';

export const INTENT_STAGE='intent-v1';
const PROMPTS=generationSets(read=>({intent:read('intent-v1.zh.md'),anti:read('anti-assistant.zh.md')}));
const DECISION_STAGES=['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph'];
const STATE_KINDS=['feeling','appraisal','intention','tension','activity','impression'];
const WORK_STATUS=['proposed','active','paused','completed','abandoned'];
const STATUS={sent:'confirmed',pending:'pending',dispatching:'pending',failed:'failed',unknown:'unknown'};
const fail=(code,message,details)=>ensure(false,code,message,details);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const str=(v,name,max)=>{ensure(typeof v==='string'&&v.trim().length>0,'INTENT_SHAPE',`${name} must be nonempty text`);ensure([...v].length<=max,'INTENT_LIMIT',`${name} longer than ${max}`);return v;};

// Packets this protocol can carry. Reflection, task steps and packets with unsupported host
// instruction suffixes (task results, re-admission) keep the full protocol.
const UNSUPPORTED_SUFFIX_MARKERS=['这是 AgentTask 单步执行','本轮 current 是 AgentTask','【显式重新准入】'];
export function intentEligible(packet){
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

// Deterministic projection of a sealed base packet. Returns the model view and the handle table.
export function intentView(base){
  const p=base.payload,c=p.continuity,handles={E0:{kind:'event',ref:{id:p.current.id,revision:p.current.revision}}};
  const view={},nowMs=Number.isSafeInteger(p.now)?p.now:null,social=c.social??null;
  if(p.identity)view.you=p.identity;
  if(p.style?.text)view.style=p.style.text;
  if(nowMs!==null)view.now=new Date(nowMs).toISOString();
  const cur=p.current;
  const curFrom=cur.origin==='tool_receipt'?'host':(social?.currentMeta?.senderName??resolveSpeakerName(null,{sender:cur.sender,actor:cur.actor}));
  const curAgo=social?.currentMeta?.ago??formatRelativeTime(cur.occurredAt??cur.recordedAt??null,nowMs);
  view.current={handle:'E0',from:curFrom,where:cur.scene??null,
    kind:cur.origin==='tool_receipt'?'tool-result':cur.origin==='observed'?'observation':'message',
    ...(curAgo?{ago:curAgo}:{}),
    ...(social?.currentMeta?.pendingInScene>0?{pendingInChat:social.currentMeta.pendingInScene}:{}),
    text:cur.body,
    attachable:(c.attention.eventProcessSupport?.enabled===true)&&(c.attention.eventProcessSupport.events??[]).some(e=>e.id===cur.id&&e.revision===cur.revision),
    ...(cur.bodyDelivery?.fullBodyDelivered===false?{partial:`只交付了 ${cur.bodyDelivery.count}/${cur.bodyDelivery.total} 项`}:{})};
  if(social?.person)view.person=social.person;
  if(social?.elsewhere?.length)view.elsewhere=social.elsewhere;
  if(social?.recentTools?.length)view.recentTools=social.recentTools;
  const recent=(c.recent?.items??[]).filter(i=>!(i.ref?.id===cur.id&&i.ref?.revision===cur.revision)).slice(-12)
    .map(i=>{
      const who=i.role==='user'?(i.senderName??resolveSpeakerName(null,{sender:i.sender,actor:i.actor})):(i.role==='assistant'||i.role==='her'?'你':i.role);
      const ago=formatRelativeTime(i.at??null,nowMs);
      return {who,where:i.scene??null,...(ago?{ago}:{}),text:i.text??'(见 current)'};
    });
  if(recent.length)view.recent=recent;
  const last=c.lastReaction;
  if(last){
    const lastAgo=formatRelativeTime(last.at??null,nowMs);
    view.lastAction={type:last.kind==='respond'?'reply':last.kind,...(last.utterance?{text:last.utterance}:{}),
      ...(last.responseStatus?{status:STATUS[last.responseStatus]??last.responseStatus}:{}),...(last.fromScene?{where:last.fromScene}:{}),...(lastAgo?{ago:lastAgo}:{})};
  }

  let n=0;const states=[];
  const cards=[...(c.foreground??[]),...(c.recalled??[]),...(c.subjectiveMemory?.recent?.items??[]),...(c.subjectiveMemory?.compressed?.items??[])];
  const seen=new Set();
  for(const s of cards){
    if(!s?.ref||s.historical||seen.has(s.ref.id))continue;seen.add(s.ref.id);
    const h='S'+(++n);handles[h]={kind:'state',ref:{id:s.ref.id,revision:s.ref.revision},stateKind:s.kind};
    const ago=formatRelativeTime(s.asOf??null,nowMs);
    states.push({handle:h,kind:s.kind,text:s.body,status:s.status,...(s.stage?{stage:s.stage}:{}),...(s.domains?.length?{domains:s.domains}:{}),...(ago?{ago}:{})});
  }
  if(states.length)view.states=states;
  if(c.subjectiveMemory&&((c.subjectiveMemory.recent?.omitted??0)>0||(c.subjectiveMemory.compressed?.count??0)>0)){
    view.memoryStats={recentCount:c.subjectiveMemory.recent?.count??0,compressedCount:c.subjectiveMemory.compressed?.count??0,
      ...(c.subjectiveMemory.recent?.omitted>0?{omittedRecent:c.subjectiveMemory.recent.omitted}:{}),
      ...(c.subjectiveMemory.compressed?.omitted>0?{omittedCompressed:c.subjectiveMemory.compressed.omitted}:{}),
      note:'完整主观记忆与压缩主题单元见 states；被省略条目可用 lookup 检索'};
  }
  if(c.mind?.unresolved?.length)view.unresolved=c.mind.unresolved.slice(0,6);
  if(c.intents?.length){
    view.goals=c.intents.slice(0,6).map(x=>({goal:x.goal,status:x.status,...(x.nextAction?{nextAction:x.nextAction}:{}),...(x.dueAt?{dueIn:formatRelativeTime(x.dueAt,nowMs)}:{}),}));
  }
  if(p.previousDecisions?.length){
    view.priorSteps=p.previousDecisions.slice(-2).map(d=>({selected:d.selected?.kind??null,summary:d.summary}));
  }

  const threads=c.threads??{},summaries=new Map([[threads.foreground?.id,threads.foreground],...(threads.background??[]).map(t=>[t.id,t])]);
  n=0;const work=[];
  for(const proc of c.attention.processes??[]){
    if(['completed','abandoned'].includes(proc.status))continue;
    const h='P'+(++n);handles[h]={kind:'process',ref:{id:proc.id,revision:proc.revision},process:proc};
    const t=summaries.get(proc.id),units=t?.history?.units??t?.units??[];
    const history=units.slice(-4).map(u=>{
      const uAgo=formatRelativeTime(u.incoming?.at??u.at??null,nowMs);
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
    .sort((a,b)=>b.intensity-a.intensity).slice(0,4).map(e=>({name:e.name,target:e.target??null,intensity:Math.round(e.intensity*100)/100}));
  if(emotions.length)view.mood=emotions;
  if(p.apperceptionV1?.enabled===true&&c.motivation?.canAppraiseCurrent===true)view.canEvaluateMood=true;
  const fb=parseHostFeedback(base.instructionSuffix);
  if(fb?.recentFeedback?.length)view.hostFeedback=fb.recentFeedback.slice(0,4);
  if(fb?.policy?.externalSend)view.sendScope=fb.policy.externalSend;

  n=0;const materials=[];
  for(const m of p.materials??[]){
    const h='M'+(++n);handles[h]={kind:'material',ref:m.ref,aspects:m.aspects};
    materials.push({handle:h,type:m.record?.type??null,text:m.record?.body??null,...(m.historical?{historical:true}:{})});
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
  view.lookup={remaining:p.memoryAccess?.remainingReads??0,...(info.length?{done:info.map(r=>({status:r.status??r.outcome??null,found:r.hits?.length??r.found??null}))}:{})};
  n=0;const tools=(p.allowedActionTools??[]).map(name=>({handle:'T'+(++n),...toolView(name)}));
  if(tools.length)view.tools=tools;
  return {view,handles};
}

export function intentPacket(base,prompts=PROMPTS.current){
  verifiedModelInput(base);
  ensure(intentEligible(base),'INTENT_PROFILE','packet is not an ordinary event decision');
  const {view,handles}=intentView(base);
  const instruction=prompts.intent+(base.payload.style?.text?'\n\n'+prompts.anti:'');
  const packetId=digest({stage:INTENT_STAGE,instruction,basePacketId:base.packetId,view});
  const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,view})}];
  const bytes=Buffer.byteLength(canonical(messages),'utf8');
  ensure(bytes<=base.budgetBytes,'INPUT_OVERFLOW','intent packet exceeds budget');
  return {stage:INTENT_STAGE,packetId,basePacket:base,instruction,messages,bytes,budgetBytes:base.budgetBytes,handles};
}
export function verifiedIntent(wire){
  ensure(wire?.stage===INTENT_STAGE,'PACKET_STAGE','not an intent packet');
  ensure(PROMPTS.all().some(prompts=>{try{return canonical(intentPacket(wire.basePacket,prompts))===canonical(wire);}catch{return false;}}),'PACKET_CHANGED','intent packet changed');
  return {packetId:wire.packetId,messages:wire.messages,bytes:wire.bytes};
}

const handle=(wire,h,kind,path)=>{const v=wire.handles[h];if(!v||v.kind!==kind)fail('INTENT_HANDLE',`${path}: “${h}” 不是本轮 view 里的${{state:'状态 S',process:'工作 P',material:'材料 M'}[kind]}编号`,{path,handle:h,expected:kind});return v;};

// Compile model intent into the ordinary full output object. Throws ContractError on
// anything ambiguous; never guesses meaning.
export function expandIntent(wire,raw,{store=null,diagnostics=[]}={}){
  verifiedIntent(wire);
  ensure(typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=32768,'OUTPUT_LIMIT','bounded JSON required');
  let o;try{o=JSON.parse(raw);}catch{fail('OUTPUT_JSON','output is not valid JSON');}
  ensure(plain(o),'INTENT_SHAPE','output must be a JSON object');
  ensure(o.packetId===wire.packetId,'WRONG_PACKET','packetId must be copied from this input');
  const base=wire.basePacket,p=base.payload,subject=p.continuity.subject.id,current=wire.handles.E0.ref;
  const salt=k=>digest({packet:base.packetId,k});
  // Process bodies are not in the catalog; read them from the exact delivered frame version.
  const frameRef=p.continuity.attention.frame,frame=store&&frameRef?store.read(frameRef.id,frameRef.revision):null;
  const bodyOf=proc=>frame?.processes?.find(x=>x.id===proc.id&&x.revision===proc.revision)?.body??null;

  // decision
  const d=o.decision;ensure(plain(d)&&typeof d.type==='string','INTENT_SHAPE','decision.type required');
  let option;
  switch(d.type){
    case 'reply':option={kind:'respond',payload:{text:str(d.text,'decision.text',2000)}};break;
    case 'act':{
      ensure(typeof d.tool==='string'&&(p.allowedActionTools??[]).includes(d.tool),'TOOL_NOT_GRANTED',`tool “${d.tool}” is not in view.tools`,{tool:d.tool});
      ensure(d.args===undefined||plain(d.args),'INTENT_SHAPE','decision.args must be an object');
      option={kind:'act',payload:{tool:d.tool,args:d.args??{}}};break;}
    case 'lookup':
      if(d.open!==undefined){const t=wire.handles[d.open];ensure(t&&['material','reminder'].includes(t.kind),'INTENT_HANDLE',`decision.open: “${d.open}” 不是本轮 view 里的材料 M 或线索 R 编号`,{path:'decision.open',handle:d.open});option={kind:'lookup',payload:{ref:t.ref}};}
      else{ensure(Array.isArray(d.terms)&&d.terms.length>0&&d.terms.length<=8,'INTENT_SHAPE','lookup needs 1-8 terms or open');d.terms.forEach((t,i)=>str(t,`decision.terms[${i}]`,80));option={kind:'lookup',payload:{terms:d.terms}};}
      break;
    case 'wait':case 'pause':case 'continue':option={kind:d.type,payload:{}};break;
    case 'none':option={kind:'none',payload:{}};break;
    default:fail('INTENT_SHAPE',`unknown decision.type “${d.type}”`);
  }

  // states → continuity.changes (+ residency so kept states stay in view)
  const states=o.states??[];ensure(Array.isArray(states)&&states.length<=8,'INTENT_LIMIT','states: at most 8');
  const changes=[],keep=[],residences=p.continuity.attention.residences??[];
  const delivered=deliveredStateRefs(p.continuity);
  for(const [i,s] of states.entries()){
    const path=`states[${i}]`;ensure(plain(s),'INTENT_SHAPE',`${path} must be an object`);
    ensure(Object.keys(s).every(k=>['update','kind','text','status','keep'].includes(k)),'INTENT_SHAPE',`${path}: only update/kind/text/status/keep`);
    if(s.status!==undefined)ensure(['open','closed'].includes(s.status),'INTENT_SHAPE',`${path}.status must be open or closed`);
    if(s.update!==undefined){
      const t=handle(wire,s.update,'state',path+'.update');
      ensure(s.kind===undefined||s.kind===t.stateKind,'STATE_IDENTITY',`${path}: kind of ${s.update} cannot change; write a new state instead`);
      ensure(s.text!==undefined||s.status!==undefined,'INTENT_SHAPE',`${path}: give text or status`);
      changes.push({id:t.ref.id,nature:'reappraisal',...(s.text!==undefined?{body:str(s.text,path+'.text',2048)}:{}),...(s.status?{status:s.status}:{}),
        basis:{observations:[current],priorStates:[t.ref],memories:[]}});
      if(s.keep!==false&&s.status!=='closed')keep.push({id:t.ref.id,revision:Math.max(t.ref.revision,...delivered.filter(r=>r.id===t.ref.id).map(r=>r.revision))+1,cue:s.text??null});
    }else{
      ensure(STATE_KINDS.includes(s.kind),'INTENT_SHAPE',`${path}.kind must be one of ${STATE_KINDS.join('/')}`);
      const id=`state:${subject}:${s.kind}:${salt('state'+i)}`;
      changes.push({id,kind:s.kind,body:str(s.text,path+'.text',2048),status:s.status??'open',nature:'encounter',basis:{observations:[current],priorStates:[],memories:[]}});
      if(s.keep!==false&&s.status!=='closed'&&s.kind!=='impression')keep.push({id,revision:1,cue:s.text});
    }
  }

  // work → attention.processes and explicit event→process links
  const work=o.work??[];ensure(Array.isArray(work)&&work.length<=4,'INTENT_LIMIT','work: at most 4');
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
  ensure(Array.isArray(o.used??[]),'INTENT_SHAPE','used must be an array of handles');
  // used is a declaration, not a state change: only delivered materials (M) count. Other
  // handles (the current item, a tool, an unopened reminder) are noted and left out; an
  // unknown handle is still an error.
  const used=(o.used??[]).filter((h,i)=>{
    const t=wire.handles[h];
    if(h==='E0'){diagnostics.push({path:`used[${i}]`,code:'CURRENT_NOT_A_MATERIAL_IGNORED'});return false;}
    if(t&&t.kind!=='material'||/^T\d+$/.test(h)&&(p.allowedActionTools??[]).length>=Number(h.slice(1))){diagnostics.push({path:`used[${i}]`,code:'NOT_A_MATERIAL_IGNORED',handle:h});return false;}
    return true;}).map((h,i)=>{const m=handle(wire,h,'material',`used[${i}]`);return {ref:m.ref,aspect:m.aspects[0],effect:'context'};});
  ensure(new Set(used.map(u=>u.ref.id)).size===used.length,'INTENT_SHAPE','used lists each material once');

  const upsert=keep.map(k=>{const old=residences.find(r=>r.target?.kind==='state'&&r.target.ref?.id===k.id);
    return {id:old?.id??`residence:${k.id}`,target:{kind:'state',ref:{id:k.id,revision:k.revision}},cue:[...(k.cue??old?.cue??'')].slice(0,160).join('')||'自己的状态',
      purposes:[{kind:'active-task',eventIds:[],questionId:null,appliesTo:null}]};});
  const attention={...keepAttention(),processes,residency:{upsert,remove:[]},...(links.length?{eventProcesses:{add:links,remove:[]}}:{})};
  const summary=typeof o.summary==='string'&&o.summary.trim()?[...o.summary].slice(0,400).join(''):'模型未提供简短说明（宿主标记）';

  let apperception,affectAppraisal;
  if(o.moodEval!==undefined&&o.moodEval!==null){
    ensure(plain(o.moodEval),'INTENT_SHAPE','moodEval must be an object');
    const m=o.moodEval;
    const meaning=str(m.meaning,'moodEval.meaning',300);
    const evLabel=m.event!==undefined?str(m.event,'moodEval.event',80):'chat';
    const valence=m.valence??0,intensity=m.intensity??0.3,agency=m.agency??'other';
    ensure(typeof valence==='number'&&Number.isFinite(valence)&&valence>=-1&&valence<=1,'INTENT_SHAPE','moodEval.valence must be -1..1');
    ensure(typeof intensity==='number'&&Number.isFinite(intensity)&&intensity>=0&&intensity<=1,'INTENT_SHAPE','moodEval.intensity must be 0..1');
    ensure(['self','other','circumstance'].includes(agency),'INTENT_SHAPE','moodEval.agency must be self/other/circumstance');
    if(p.apperceptionV1?.enabled===true){
      apperception={schema_version:'apperception.slice.v1',activated_cells:[{domain:p.continuity.social?.person?'relationship':'self',perspective:'meaning',content:meaning,epistemic_status:'interpretation',source_refs:[current],uncertainty:null}],integrated_understanding:meaning};
      if(p.continuity.motivation?.canAppraiseCurrent===true){
        affectAppraisal={schema_version:'affect.appraisal.v2',mode:'encounter',source_refs:[current],reason:summary,
          appraisals:[{weight:1,value:{event:evLabel,summary:meaning,valence,intensity,relevance:Math.max(0.2,intensity),agency,target:p.continuity.social?.person?.who?.id??null}}]};
      }
    }else{
      diagnostics.push({path:'moodEval',code:'MOOD_EVAL_IGNORED',reason:'apperception/affect not enabled for this packet'});
    }
  }

  return {packetId:base.packetId,options:[{id:'chosen',...option}],selected:'chosen',summary,used,
    ...(apperception?{apperception}:{}),...(affectAppraisal?{affectAppraisal}:{}),
    continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}};
}

// The wire a given intent output answered: any known prompt generation whose packetId matches.
export function intentWireFor(base,packetId){
  for(const prompts of PROMPTS.all()){let w;try{w=intentPacket(base,prompts);}catch{continue;}if(w.packetId===packetId)return w;}
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
