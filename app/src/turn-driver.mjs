// 她的一轮：收观察 → 问她的节律 → 组装最合理的处境 → 把决定权交给她 → 执行她的选择 → 收出站/等待。
// 宿主只提供事实、结构、资源与执行；不替她挑焦点、不替她写记忆、不替她解释。
import {canonical,digest,ensure,text} from './contracts.mjs';
import {ContinuitySession} from './continuity-session.mjs';
import {LocalLookupSession} from './local-lookup.mjs';
import {prepareReflection} from './cognition.mjs';
import {reflectionFrame} from './reflection-frame.mjs';
import {rhythmConfig,rhythmTick} from './rhythm.mjs';
import {recordEpisodes} from './tendency.mjs';
import {observeAssociation} from './association-observe.mjs';

const ref=r=>({id:r.id,revision:r.revision});

export class TurnDriver {
  #store;#subjectId;#session;#lookup;#decide;#config;#lookupPolicy;#workspace;#identity;#style;#eventBypass;#materialsFor;#maxCalls;#state;#outbox;#tendency;#allowed;#capabilities;#tickChain;#tasks;
  constructor({store,subjectId,decide,workspace,identity='',style='',eventBypass=false,materialsFor=null,rhythm={},lookupPolicy={maxReads:2,maxHits:4},maxCallsPerTurn=3,maxForeground=16,tendency=null,allowedActionTools=[],capabilities=null,tasks=null}={}){
    ensure(store&&typeof store.execute==='function','TURN_DRIVER','store required');
    text(subjectId,'subject id');ensure(typeof decide==='function','TURN_DRIVER','decide function required');
    const w=store.read(workspace?.id??workspace,workspace?.revision);
    ensure(w?.type==='workspace','TURN_DRIVER','existing workspace required');
    ensure(typeof identity==='string'&&[...identity].length<=4000,'TURN_DRIVER','bounded identity required');
    ensure(Number.isSafeInteger(maxCallsPerTurn)&&maxCallsPerTurn>=1&&maxCallsPerTurn<=8,'TURN_DRIVER','1..8 calls per turn');
    ensure(tendency===null||(tendency?.learning&&typeof tendency.learning.material==='function'&&typeof tendency.learning.observe==='function'
      &&tendency.spec&&typeof tendency.contextFor==='function'),'TURN_DRIVER','explicit tendency session and context provider required');
    ensure(Array.isArray(allowedActionTools)&&allowedActionTools.length<=64,'TURN_DRIVER','up to 64 granted action tools');
    allowedActionTools.forEach(t=>text(t,'tool'));
    this.#store=store;this.#subjectId=subjectId;this.#decide=decide;this.#workspace=ref(w);
    this.#identity=identity;this.#style=String(style??'').slice(0,16000);this.#eventBypass=eventBypass===true;this.#materialsFor=typeof materialsFor==='function'?materialsFor:()=>[];
    this.#maxCalls=maxCallsPerTurn;this.#lookupPolicy=lookupPolicy;this.#tendency=tendency;
    this.#allowed=[...new Set(allowedActionTools)].sort();
    ensure(capabilities===null||Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string'),'TURN_DRIVER','capabilities must be null or a string array');
    this.#capabilities=capabilities;this.#tasks=typeof tasks==='function'?tasks:null;
    this.#session=new ContinuitySession({store,subjectId,attention:true,maxForeground});
    this.#lookup=new LocalLookupSession({store,subjectId,policy:lookupPolicy});
    this.#config=rhythmConfig(rhythm);
    this.#state={lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null};
    this.#outbox=[];
    this.#tickChain=Promise.resolve();
  }
  get state(){return {...this.#state};}
  get subjectId(){return this.#subjectId;}
  setStyle(style){this.#style=String(style??'').slice(0,16000);}

  // 观察入账：同一 source key 幂等；admit 让收件箱可见（重复也幂等）。不决定事情，只记事实。
  ingest({key,body,actor='brother',sender=null,scene='local-chat',origin='reported',at=Date.now(),sourceSystem='turn-driver',sourceKey=null,admit=true}){
    text(key,'observation key');text(body,'observation body');
    const id='obs:'+key;
    const ev=this.#store.execute({requestId:`ingest:${id}`,commands:[{op:'append_event',id,body,origin,actor,scene,...(sender?{sender}:{}),occurredAt:at,source:{system:sourceSystem,key:sourceKey??id}}]}).at(-1);
    if(admit)this.#store.execute({requestId:`admit:${digest({subject:this.#subjectId,event:ref(ev)})}`,
      commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:ref(ev)}]});
    return ref(ev);
  }

  // 节律机会：醒来 ≠ 必须思考。没有待处理观察时只是空闲；预算门由节律层给出。
  // eventId：只处理这一条观察（调用方已按收件箱确定）；不给则取最早的“新收到”观察，
  // 已 deferred 的旧观察排在新观察之后，不再堵住队首（否则会处理 A 却留下 B，或旧消息反复出现）。
  tick(options={}){
    // 同一主体的 tick 串行：上一条决策/回复提交完成后，下一条才准备 packet。
    const run=this.#tickChain.then(()=>this.#runTick(options));
    this.#tickChain=run.catch(()=>{});
    return run;
  }
  async #runTick({now=Date.now(),localHour=null,dayKey=null,memoryUpdate=false,memoryWindow=null,eventBypass=this.#eventBypass,eventId=null}={}){
    let pending=this.#store.subjectInbox({subjectId:this.#subjectId,limit:100,pendingOnly:true}).items;
    if(eventId!==null){
      pending=pending.filter(item=>item.eventId===eventId);
      if(pending.length===0)return {wake:false,reason:'not-pending',stale:true,eventId};
    }else{
      pending=[...pending.filter(item=>item.status==='received'),...pending.filter(item=>item.status!=='received')];
    }
    const day=dayKey??new Date(now).toISOString().slice(0,10);
    const calls=day===this.#state.dayKey?this.#state.callsToday:0;
    // 记忆机会不受“节律还没到”限制；否则 idleReflect 在非 beat 时刻永远返回 wake:false。
    // 但仍尊重当天模型调用上限，不绕过预算。
    if(memoryUpdate&&pending.length===0){
      if(calls>=this.#config.dailyCallCap)return {wake:true,reason:'memory-update',action:'budget-blocked',pending:0};
      return this.#runReflection({now,reason:'memory-update',memoryUpdate:true,memoryWindow});
    }
    const hour=localHour??new Date(now).getHours();
    // 事件旁路只为“新收到”的观察破节律；deferred 的旧观察只能等节律醒来或被明确指定，避免每次心跳都重复烧调用。
    const fresh=eventId!==null?pending:pending.filter(item=>item.status==='received');
    if(eventBypass&&fresh.length>0){
      const dayKeyNow=dayKey??new Date(now).toISOString().slice(0,10);
      const callsNow=dayKeyNow===this.#state.dayKey?this.#state.callsToday:0;
      if(callsNow>=this.#config.dailyCallCap)return {wake:false,reason:'budget',pending:pending.length};
      if(dayKeyNow!==this.#state.dayKey)this.#state.callsToday=0; // 跨天重置，否则旁路路径的日上限永不归零
      this.#state.lastWakeAt=now;this.#state.dayKey=dayKeyNow;
      return this.#runDecision({now,observation:fresh[0],reason:'event'});
    }
    const r=rhythmTick({now,localHour:hour,state:{lastWakeAt:this.#state.lastWakeAt??(now),nextWakeAt:this.#state.nextWakeAt,
      callsToday:calls,clockSuspect:false,pendingEvents:pending.length},config:this.#config});
    this.#state={lastWakeAt:r.state.lastWakeAt,nextWakeAt:r.state.nextWakeAt,callsToday:r.state.callsToday,dayKey:day};
    if(!r.wake)return {wake:false,reason:r.reason,nextAt:r.nextAt};
    if(!r.modelAllowed)return {wake:true,reason:r.reason,action:'budget-blocked',pending:pending.length,nextAt:r.nextAt};
    if(pending.length===0)return this.#runReflection({now,reason:r.reason});
    return this.#runDecision({now,observation:pending[0],reason:r.reason});
  }

  // 节律醒来但没有新观察：给内部时间/注意力摘要，让她自己决定要不要做点什么（不写事件）。
  async taskWake({now=Date.now(),task=null}={}){
    const run=this.#tickChain.then(()=>this.#runReflection({now,reason:'task-due',task}));
    this.#tickChain=run.catch(()=>{});return run;
  }
  async #runReflection({now,reason,memoryUpdate=false,task=null,memoryWindow=null}){
    const internal=reflectionFrame({read:(id,rev)=>this.#store.read(id,rev),subjectId:this.#subjectId,workspace:this.#workspace,now,
      sinceLastInteraction:this.#state.lastWakeAt===null?null:Math.max(0,now-this.#state.lastWakeAt),
      waitingUntil:this.#state.nextWakeAt});
    const lookups=[],outbox=[];let decision=null,choiceKind=null;
    for(let c=0;c<this.#maxCalls;c++){
      const packet=prepareReflection({store:this.#store,subjectId:this.#subjectId,workspace:this.#workspace,identity:this.#identity,
        internal,budgetBytes:120000,allowedActionTools:this.#allowed,lookupResults:lookups,capabilities:this.#capabilities,tasks:this.#tasks?.()??[],memoryUpdateDue:memoryUpdate,memoryWindow,style:this.#style,taskWake:reason==='task-due',taskDue:task?{id:task.id,goal:task.goal,currentStep:task.currentStep,nextStep:task.nextStep,checkpoint:task.checkpoint,status:task.status}:null});
      this.#state.callsToday++;
      const output=await this.#decide(packet);
      const decisionId=`reflection:${packet.packetId}:${Date.now().toString(36)}`;
      decision=this.#commitWithFallback({packet,output,decisionId,requestId:decisionId});
      observeAssociation({store:this.#store,packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls)return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),lookups};
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        continue;
      }
      this.#pushChoice(outbox,choice,decision);
      if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#outbox.push(...outbox);
    return {wake:true,reason,action:'reflected',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  async #runDecision({now,observation,reason}){
    const event=this.#store.read(observation.eventId);
    ensure(event?.type==='event','TURN_DRIVER','pending observation must be an existing event');
    const current=ref(event),lookups=[],outbox=[];
    const materials=[...(this.#materialsFor({store:this.#store,subjectId:this.#subjectId,event:current,now})??[])];
    // 长期经验卡：宿主先确认这是"她自己的学习语境"，才生成并作为知识材料交付；卡片不是指令。
    if(this.#tendency){
      const context=this.#tendency.contextFor({store:this.#store,event:current,now});
      if(context){const card=this.#tendency.learning.material({context});materials.push({ref:card.ref,aspect:'knowledge'});}
    }
    let decision=null,choiceKind=null;
    for(let c=0;c<this.#maxCalls;c++){
      const packet=this.#session.prepare({currentEvent:current,workspace:this.#workspace,identity:this.#identity,style:this.#style,materials,previousDecisions:[],
        mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
        localLookupPolicy:this.#lookupPolicy,lookupResults:lookups,allowedActionTools:this.#allowed,budgetBytes:120000,now,capabilities:this.#capabilities,tasks:this.#tasks?.()??[]});
      this.#state.callsToday++;
      const output=await this.#decide(packet);
      const decisionId=`${event.id}:decision:${c}:${Date.now().toString(36)}`;
      decision=this.#commitWithFallback({packet,output,decisionId,requestId:`turn:${event.id}:${c}:${Date.now().toString(36)}`});
      observeAssociation({store:this.#store,packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls)return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),outbox,lookups};
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        continue;
      }
      this.#pushChoice(outbox,choice,decision);
      if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#outbox.push(...outbox);
    return {wake:true,reason,action:'decided',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  #commitWithFallback({packet,output,decisionId,requestId}){
    try{return this.#session.commit({packet,output,decisionId,requestId,allowedActionTools:this.#allowed,maxOutputBytes:32768});}
    catch(error){
      const stateErrors=new Set(['RESIDENCY_CONFLICT','UNDELIVERED_BASIS','UNREAD_STATE','MIND_KIND','STALE_SUBJECT','STALE_ATTENTION']);
      if(!stateErrors.has(error.code)||!output?.continuity)throw error;
      // 状态更新不合法时保留本轮说话/动作，丢弃这次状态增量，避免整轮静默失败。
      const fallback={...output,continuity:{...output.continuity,changes:[],residency:{add:[],remove:[]},attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};
      try{return this.#session.commit({packet,output:fallback,decisionId,requestId,allowedActionTools:this.#allowed,maxOutputBytes:32768});}
      catch(second){
        if(!['RESIDENCY_CONFLICT','UNDELIVERED_BASIS','UNREAD_STATE','MIND_KIND','STALE_SUBJECT','STALE_ATTENTION'].includes(second.code))throw second;
        // 第二次仍失败：完全不带 continuity 提交，保留说话/动作，不写状态。
        const bare={...output};delete bare.continuity;
        return this.#session.commit({packet,output:bare,decisionId,requestId,allowedActionTools:this.#allowed,maxOutputBytes:32768});
      }
    }
  }  #pushChoice(outbox,choice,decision){
    const speech=choice.kind==='respond'||(choice.kind==='turn'&&Array.isArray(choice.payload.utterances)&&choice.payload.utterances.length)?choice.payload:null;
    if(speech){const response=this.#store.read(`${decision.id}:response`);outbox.push({kind:'respond',text:speech.text??speech.utterances?.[0]?.text??'',...(Array.isArray(speech.utterances)?{utterances:speech.utterances}:{}),...(response?{response:{id:response.id,revision:response.revision}}:{})});}
    if(choice.kind==='act')outbox.push({kind:'act',tool:choice.payload.tool,args:choice.payload.args,action:decision.action??null});
    else if(choice.kind==='turn')for(const [index,item] of (choice.payload.actions??[]).entries())
      outbox.push({kind:'act',tool:item.tool,args:item.args,action:decision.actions?.[index]??null});
  }
  takeOutbox(){const out=this.#outbox;this.#outbox=[];return out;}

  // 真实回执入账（执行结果只能来自宿主；这里只记录，不推断她是否“学到”）。
  applyReceipt({action,status,body,eventId,actor='host',sourceSystem='host',occurredAt}={}){
    ensure(action,'TURN_DRIVER','action reference required');
    const existing=this.#store.read(eventId);
    if(existing?.type==='event'&&existing.origin==='tool_receipt'){
      const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
      return {receipt:ref(existing),tendency,replayed:true};
    }
    const live=this.#store.read(action.id,action.revision);
    ensure(live?.type==='action','TURN_DRIVER','existing action required');
    const ev=this.#store.execute({requestId:`receipt:${eventId}`,commands:[{op:'record_receipt',actionId:live.id,
      expectedRevision:live.revision,status,eventId,body,source:{system:sourceSystem,key:eventId},actor,occurredAt:occurredAt??Date.now()}]}).at(-1);
    const receipt=ev.receipt;
    this.#store.execute({requestId:'receipt-admit:'+eventId,commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:receipt}]});
    const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
    return {receipt,tendency};
  }

  // 节律状态存成版本化 note：重启后接得上；内容只是时钟与预算，不是经历。
  loadState(){
    const id=`rhythm:${this.#subjectId}`,note=this.#store.read(id);
    if(!note?.body)return false;
    let data;try{data=JSON.parse(note.body);}catch{return false;}
    if(data?.format!=='rhythm-state-v1')return false;
    this.restore({state:{lastWakeAt:data.lastWakeAt??null,nextWakeAt:data.nextWakeAt??null,callsToday:data.callsToday??0,dayKey:data.dayKey??null}});
    return true;
  }
  persistState(){
    const id=`rhythm:${this.#subjectId}`,old=this.#store.read(id),body=canonical({format:'rhythm-state-v1',...this.#state});
    const out=this.#store.execute({requestId:`rhythm-state:${digest({id,body,expected:old?.revision??0})}`,
      commands:[{op:'write_note',id,expectedRevision:old?.revision??0,kind:'skill',change:'self_report',evidence:[],body}]}).at(-1);
    return ref(out.record);
  }

  snapshot(){return {state:{...this.#state},outbox:[...this.#outbox]};}
  restore(snapshot){
    ensure(snapshot&&typeof snapshot==='object','TURN_DRIVER','snapshot required');
    const s=snapshot.state??{};
    for(const key of ['lastWakeAt','nextWakeAt'])ensure(s[key]===null||Number.isSafeInteger(s[key]),'TURN_DRIVER',`invalid ${key}`);
    ensure(Number.isSafeInteger(s.callsToday??0)&&(s.callsToday??0)>=0,'TURN_DRIVER','invalid callsToday');
    this.#state={lastWakeAt:s.lastWakeAt??null,nextWakeAt:s.nextWakeAt??null,callsToday:s.callsToday??0,dayKey:s.dayKey??null};
    this.#outbox=Array.isArray(snapshot.outbox)?[...snapshot.outbox]:[];
  }
}
