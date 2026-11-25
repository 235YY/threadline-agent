import {validateBudgetRows} from './budget-integrity.mjs';
import {continuationAuthorization,verifyContinuationLedger} from './budget-continuation.mjs';
import {dailySpendPolicy,verifyDailySpend,dailySpendUsage,beijingDay,billingRates,tokenCharge} from './daily-spend-policy.mjs';
// 真实模型传输：把"她的决定"接到已计费的模型客户端；日预算、显式凭证、不重试。
// 只负责"问一次、记一次账"，不解释输出、不替她决定。
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensure,digest} from './contracts.mjs';
import {verifiedModelInput} from './cognition.mjs';
function verifiedBeforeTransport(packet){try{return verifiedModelInput(packet);}catch(error){error.transportInvoked=false;error.failurePhase='host-input-validation';throw error;}}
import {readBlob} from './blobs.mjs';
import {redactSensitiveEgress} from './security-guard.mjs';
import {buildWorkChannelRequest,sanitizeWorkChannelResponse,validateWorkApiRequest} from './work-channel.mjs';
import {messageImageRefs} from './message.mjs';
import {DeepSeekStudyClient,RATES,requireStudyNetwork,reuseSuccessfulNetworkProbe} from './model-client.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';
import {studyKey} from './model-credential.mjs';
import {resetAuthorization,verifyResetLedger} from '../tools/ops/reset-budget-contract.mjs';
import {recoverOutputOnce,selectedModelOutput,proposalFormatIssue} from './model-output-recovery.mjs';

export function toProviderMessages(messages,{blobDirectory=null,packet=null,stagedHistory=false}={}){
  const marker=/\[\[image:(https?:\/\/[^\]\s]+|data:image\/[^\]\s]+)\]\]/g;
  const out=messages.map((m,index)=>{
    if(stagedHistory&&index>0&&index<messages.length-1)return m;
    if(typeof m?.content!=='string'||!m.content.includes('[[image:'))return m;
    const parts=[];let last=0;marker.lastIndex=0;let x;
    while((x=marker.exec(m.content))){const text=m.content.slice(last,x.index).trim();if(text)parts.push({type:'text',text});parts.push({type:'image_url',image_url:{url:x[1]}});last=x.index+x[0].length;}
    const tail=m.content.slice(last).trim();if(tail)parts.push({type:'text',text:tail});
    return {...m,content:parts};
  });
  const appendImages=(messages,refs)=>{if(!refs.length)return;const last=messages.length-1;if(last<0||messages[last]?.role!=='user')return;const content=typeof messages[last].content==='string'?[{type:'text',text:messages[last].content}]:[...messages[last].content];for(const ref of refs){let bytes;try{bytes=readBlob({directory:blobDirectory,ref:ref.ref});}catch(error){throw Object.assign(new Error(`image blob unavailable: ${ref.ref}`),{code:'IMAGE_BLOB_UNAVAILABLE',cause:error});}const data=`data:${ref.mediaType};base64,${bytes.toString('base64')}`;// The fetched content-addressed blob is authoritative; sourceUrl remains provenance, not a second remote download.
const url=data;content.push({type:'image_url',image_url:{url}});}messages[last]={...messages[last],content};};
  const current=packet?.payload?.current;
  if(current?.message?.format==='jingyang-message-v1'&&blobDirectory)appendImages(out,messageImageRefs(current.message));
  const task=packet?.payload?.task;
  if(task&&Array.isArray(task.interrupts)&&blobDirectory){for(const interrupt of task.interrupts){if(interrupt?.messageParts?.format==='jingyang-message-v1')appendImages(out,messageImageRefs(interrupt.messageParts));}}
  return out;
}
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const usedMicros=rows=>rows.reduce((sum,r)=>sum+(r.status==='settled'?r.actualMicros:r.status==='released'?0:r.reserveMicros),0);

export class DailyBudgetLedger {
  constructor(path,{dailyMicros=3000000,dailyCalls=96,dayKey=new Date().toISOString().slice(0,10),clock=Date.now,enforce=true}={}){
    textPath(path);
    this.reset=resetAuthorization(path);
    this.continuation=continuationAuthorization(path);
    this.daily=dailySpendPolicy(path);this.clock=clock;this.enforce=enforce;
    if(this.daily){ensure(dailyMicros===this.daily.dailyMicros&&dailyCalls===null,'BUDGET_POLICY','standing daily limits must match approval');dayKey=beijingDay(clock());}
    if(this.continuation){ensure(existsSync(path)&&dailyCalls===null&&dailyMicros===this.continuation.activeLimitMicros,'BUDGET_POLICY','continuation limits must match approved carry');dayKey=this.continuation.dayKey;}
    ensure(!this.reset||existsSync(path),'BUDGET_POLICY','reset phase ledger missing; do not recreate it');
    if(this.reset){ensure(dailyCalls===this.reset.maxCalls&&dailyMicros===this.reset.maxMicros,'BUDGET_POLICY','reset phase limits cannot change');dayKey=this.reset.dayKey;}
    ensure(Number.isSafeInteger(dailyMicros)&&dailyMicros>0&&dailyMicros<=20000000,'BUDGET_POLICY','dailyMicros 1..20000000');
    ensure(dailyCalls===null?(this.reset?.maxCalls===null||this.continuation?.maxCalls===null||this.daily?.maxCalls===null):Number.isSafeInteger(dailyCalls)&&dailyCalls>0&&dailyCalls<=1000,'BUDGET_POLICY','unlimited count requires explicit budget-only authorization');
    ensure(DAY.test(dayKey),'BUDGET_POLICY','dayKey must be YYYY-MM-DD');
    this.path=path;this.lock=path+'.lock';mkdirIfNeeded(dirname(path));
    try{this.fd=openSync(this.lock,'wx');}catch{ensure(false,'LEDGER_LOCKED','another writer holds the daily budget; do not auto-resend');}
    try{
      if(existsSync(path)){
        const previous=JSON.parse(readFileSync(path,'utf8'));
        ensure(previous.format==='jingyang-daily-brain-budget-v1','BUDGET_POLICY','unknown budget file format');validateBudgetRows(previous.requests);
        if(this.reset)verifyResetLedger(previous,this.reset);
        if(this.continuation)verifyContinuationLedger(previous,this.continuation);
        if(this.daily){
          verifyDailySpend(previous,this.daily);ensure(previous.dayKey<=dayKey,'BUDGET_CLOCK','accounting clock moved backwards');
          this.data={...previous,dayKey,dailyMicros,dailyCalls,dailyPolicySha256:this.daily.hash};
          if(!this.data.halted&&this.data.requests.some(r=>['reserved','dispatched','uncertain'].includes(r.status)))this.data.halted='recovered unconfirmed request; reservation retained; explicit reconciliation required';
          this.save();return;
        }
        if(previous.dayKey!==dayKey){
          ensure(!previous.requests.some(r=>['reserved','dispatched','uncertain'].includes(r.status)),'BUDGET_RECOVERY_REQUIRED','old unconfirmed costs must be reconciled before day rollover');
          const archive=`${path}.${previous.dayKey}.json`;
          renameSync(path,existsSync(archive)?`${path}.${previous.dayKey}.${randomUUID()}.json`:archive);
        }else{
          ensure(previous.dailyMicros===dailyMicros&&previous.dailyCalls===dailyCalls,'BUDGET_POLICY','same-day limits cannot change mid-day');
          this.data=previous;
          if(!this.data.halted&&this.data.requests.some(r=>['reserved','dispatched','uncertain'].includes(r.status)))this.data.halted='recovered unconfirmed request; reservation retained; explicit reconciliation required';
          this.save();return;
        }
      }
      ensure(!this.daily,'BUDGET_POLICY','standing ledger history missing; do not recreate it');
      this.data={format:'jingyang-daily-brain-budget-v1',dayKey,dailyMicros,dailyCalls,requests:[],halted:null,auditEvents:[]};
      this.save();
    }catch(error){this.close();throw error;}
  }
  save(){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','closed or failed ledger cannot authorize requests');
    try{writeLedgerAtomically(this.path,this.data);}catch(error){this.poisoned=true;throw error;}
  }
  reserve(id,fingerprint,reserveMicros){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');
    if(this.enforce)ensure(!this.data.halted,'BUDGET_HALTED','legacy budget halted; official runtime uses RequestJournal');
    this.refreshDay();
    if(this.daily)ensure(!this.daily.history.has(id),'ALREADY_REQUESTED','historical requests cannot be resent');
    ensure(this.reset?.validUntil===undefined||Date.now()<this.reset.validUntil,'BUDGET_EXPIRED','today authorization expired; no automatic renewal');
    ensure(!this.continuation||Date.now()<this.continuation.validUntil,'BUDGET_EXPIRED','continuation authorization expired');
    if(this.continuation)ensure(!this.continuation.carried.some(r=>r.id===id),'ALREADY_REQUESTED','carried requests cannot be resent');
    if(this.reset)ensure(!this.reset.previousData.requests.some(r=>r.id===id),'ALREADY_REQUESTED','archived request may not be resent after reset');
    ensure(typeof id==='string'&&id.length>0&&typeof fingerprint==='string'&&fingerprint.length>0,'REQUEST_ID','nonempty request and fingerprint required');
    ensure(!this.data.requests.some(r=>r.id===id),'ALREADY_REQUESTED','never automatically resend a request id');
    ensure(this.data.dailyCalls===null||this.data.requests.length<this.data.dailyCalls,'CALL_LIMIT','daily call limit reached');
    ensure(Number.isSafeInteger(reserveMicros)&&reserveMicros>0,'RESERVE_AMOUNT','positive integer reservation required');
    const held=this.daily?dailySpendUsage(this.data,this.daily,this.data.dayKey).held:usedMicros(this.data.requests);
    if(this.enforce)ensure(held+reserveMicros<=this.data.dailyMicros,'SPEND_LIMIT','daily budget cannot cover this call');
    this.data.requests.push({id,fingerprint,reserveMicros,status:'reserved',...(this.daily?{budgetDay:this.data.dayKey,budgetReservedAt:this.clock(),billingRates:billingRates(this.clock())}:{})});this.save();
  }
  dispatch(id){const r=this.find(id);ensure(r.status==='reserved','REQUEST_STATE','request is not reserved');r.status='dispatched';this.save();}
  release(id){const r=this.find(id);if(r.status==='released')return;ensure(r.status==='reserved','REQUEST_STATE','only unsent reservation can be released');r.status='released';this.save();}
  settle(id,usage){
    ensure(Number.isSafeInteger(usage?.upperMicros)&&usage.upperMicros>=0,'USAGE_AMOUNT','settlement requires nonnegative safe integer amount');
    const r=this.find(id);if(r.status==='settled')return;
    ensure(r.status==='dispatched','REQUEST_STATE','request not dispatched');
    r.status='settled';r.usage=usage;r.actualMicros=usage.upperMicros;
    if(this.daily&&r.billingRates)r.accounting={method:'raw-token-usage-times-frozen-published-rate',calculatedMicros:tokenCharge(usage,r.billingRates)??usage.upperMicros,providerDeduction:null,legacyActualMicrosIsPeakUpper:true};
    if(r.actualMicros>r.reserveMicros)this.data.halted='provider usage exceeded conservative reservation';this.save();
    ensure(r.actualMicros<=r.reserveMicros,'RESERVATION_OVERRUN','settled usage exceeded reservation; stop');
  }
  uncertain(id,code){const r=this.find(id);if(r.status==='uncertain')return;ensure(r.status==='dispatched','REQUEST_STATE','only dispatched requests can become cost-unknown');r.status='uncertain';r.error=code;this.data.halted='request cost not confirmed; do not auto-retry';this.save();}
  attachOutput(id,output){const r=this.find(id);ensure(r.status==='settled','REQUEST_STATE','only settled requests keep output');r.output=output;this.save();}
  attachProviderResult(id,response){const r=this.find(id);ensure(r.status==='settled','REQUEST_STATE','only settled requests keep provider result');r.providerResult={complete:response.complete===true,finishReason:response.finishReason??null,reportedModel:response.reportedModel??null,providerResponseId:response.providerResponseId??null,output:response.output??''};this.save();}
  attachWireTelemetry(id,telemetry){const r=this.tryFind(id);if(!r||!telemetry)return;r.wireTelemetry=telemetry;this.save();}
  find(id){const r=this.data.requests.find(r=>r.id===id);ensure(r,'REQUEST_STATE','unknown request');return r;}
  tryFind(id){return this.data.requests.find(r=>r.id===id)??null;}
  refreshDay(){if(!this.daily)return;const day=beijingDay(this.clock());ensure(day>=this.data.dayKey,'BUDGET_CLOCK','accounting clock moved backwards');if(day!==this.data.dayKey){this.data.dayKey=day;this.save();}}
  state(){this.refreshDay();const rows=this.data.requests;if(this.daily){const usage=dailySpendUsage(this.data,this.daily,this.data.dayKey);return {dayKey:this.data.dayKey,timeZone:'Asia/Shanghai',calls:rows.filter(r=>(r.budgetDay??this.daily.initial.dayKey)===this.data.dayKey).length,totalCalls:rows.length,settled:rows.filter(r=>r.status==='settled').length,uncertain:rows.filter(r=>r.status==='uncertain').length,costMicros:usage.actual,reservedMicros:usage.reserved,historicalReservedMicros:usage.historicalReserved,heldMicros:usage.held,remainingMicros:Math.max(0,this.data.dailyMicros-usage.held),limitMicros:this.data.dailyMicros,maxCalls:null,halted:this.data.halted};}return {dayKey:this.data.dayKey,calls:rows.length,settled:rows.filter(r=>r.status==='settled').length,uncertain:rows.filter(r=>r.status==='uncertain').length,
    costMicros:rows.reduce((sum,r)=>sum+(r.status==='settled'?r.actualMicros:0),0),limitMicros:this.data.dailyMicros,maxCalls:this.data.dailyCalls,halted:this.data.halted};}
  close(){if(this.fd===undefined)return;closeSync(this.fd);this.fd=undefined;try{unlinkSync(this.lock);}catch{}}
}
function textPath(path){ensure(typeof path==='string'&&path.length>0,'TRANSPORT_CONFIG','ledger path required');}
function mkdirIfNeeded(dir){ensure(typeof dir==='string','TRANSPORT_CONFIG','invalid ledger directory');if(!existsSync(dir))mkdirSync(dir,{recursive:true});}

// 默认：专用 key、真实网络预检、json 输出、low 思考、日预算 3 元/96 次。
export function modelRequestSource(packet,provided=null){
  const p=packet.payload??{},subject=p.continuity?.subject?.id;
  ensure(typeof subject==='string','REQUEST_SOURCE','fixed subject required');
  if(p.task)return {subject,kind:'task',taskId:p.task.id,step:p.task.stepCount};
  if(p.current)return {subject,kind:'event',event:{id:p.current.id,revision:p.current.revision}};
  ensure(provided?.subject===subject&&provided.kind==='reflection'&&typeof provided.opportunity?.id==='string'&&Number.isSafeInteger(provided.opportunity.revision),'REQUEST_SOURCE','reflection requires its existing durable opportunity reference');
  return {subject,kind:'reflection',opportunity:{id:provided.opportunity.id,revision:provided.opportunity.revision}};
}
import {intentEligible,intentPacket,intentFormatIssue} from './intent-protocol.mjs';
import {buildStagedMessages,buildStagedReflectionMessages,createSceneWindowTracker,resolveWireLayout} from './staged-wire-layout.mjs';
export function createModelDecision({ledgerPath,blobDirectory=null,getKey=studyKey,transport=fetch,networkCheck=requireStudyNetwork,profile={},dayKey=null,timeoutMs=120000,enforceBudget=true,requestJournal=null,officialSpend=null}={}){
  ensure(typeof ledgerPath==='string'&&ledgerPath.length>0,'TRANSPORT_CONFIG','ledger path required');
  const limits={...(dayKey?{dayKey}:{}),...(Number.isSafeInteger(profile.dailyMicros)?{dailyMicros:profile.dailyMicros}:{}),
    ...(profile.dailyCalls===null||Number.isSafeInteger(profile.dailyCalls)?{dailyCalls:profile.dailyCalls}:{})};
  const ledger=requestJournal??new DailyBudgetLedger(ledgerPath,{...limits,enforce:enforceBudget});
  const journalled=typeof ledger.sourceRequest==='function';
  const admitRequest=officialSpend?()=>{const g=officialSpend.gate();ensure(g.allow,g.known?'OFFICIAL_BUDGET_LIMIT':'OFFICIAL_USAGE_UNAVAILABLE','official usage must be fresh and below 5 yuan');}:null;
  const preflight=networkCheck===requireStudyNetwork?reuseSuccessfulNetworkProbe(networkCheck):networkCheck;
  const client=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck:preflight,stream:profile.upstreamSse===true,maxTokens:profile.maxTokens??3000,timeoutMs,
    outputFormat:'json',reasoning:profile.reasoning??'low',inputVerifier:packet=>packet,admitRequest});
  const maintenanceClient=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck:preflight,stream:profile.upstreamSse===true,maxTokens:profile.maxTokens??3000,timeoutMs,
    outputFormat:'json',reasoning:profile.reasoning??'low',inputVerifier:packet=>packet,admitRequest});
  // Opt-in: ordinary event decisions are sent as the small intent protocol; the
  // answer is compiled into the full output at commit. Request identity is unchanged.
  const intentWire=packet=>profile.intentProtocol===true&&intentEligible(packet)?intentPacket(packet):null;
  // Opt-in Phase 1 wire layout ('legacy' by default; 'staged-v1' reorders messages without altering ContinuitySession).
  const wireLayoutMode=resolveWireLayout(profile.wireLayout??process.env.THREADLINE_WIRE_LAYOUT??'legacy');
  const sceneWindowTracker=wireLayoutMode==='staged-v1'?createSceneWindowTracker():null;
  const stagedOptions={...profile.wireLayoutOptions,provider:'deepseek',anthropicCacheControl:false};
  const prepareWireMessages=(packet,verified,wire)=>{
    if(wireLayoutMode!=='staged-v1')return {applied:false,messages:wire?.messages??verified.messages};
    if(wire)return buildStagedMessages({wire,packet,tracker:sceneWindowTracker,options:stagedOptions});
    return buildStagedReflectionMessages(packet,verified);
  };
  async function decide(packet,{beforeCorrection=null,source:providedSource=null}={}){
    const startedAt=Date.now();
    const source=journalled?modelRequestSource(packet,providedSource):null,prior=source?ledger.sourceRequest(source):null;
    const bound=journalled?ledger.packetRequest(packet?.packetId):null;
    const id=bound?.id??(prior?.status==='reserved'&&prior.fingerprint===null?prior.id:`turn:${packet?.packetId}`);
    if(prior&&prior.id!==id)ensure(!ledger.blocks(source),'SOURCE_REQUEST_BLOCKED','original source remains unresolved or rejected',{requestId:prior.id,source});
    const existing=ledger.tryFind(id);
    ensure(existing?.validation?.status!=='rejected','SOURCE_OUTPUT_REJECTED','original output was rejected; do not resubmit its source');
    if(existing?.status==='settled'&&typeof existing.output==='string'){
      if(existing.proposalRecovery){
        if(profile.formatRecovery===true&&!existing.proposalRecovery.closed){
          const verified=verifiedBeforeTransport(packet),wire=intentWire(packet);
          const staged=existing.wireTelemetry?.wireLayout==='staged-v1'&&wire
            ?buildStagedMessages({wire,packet,tracker:createSceneWindowTracker({initialAnchor:existing.wireTelemetry.historyAnchor}),
                options:{...stagedOptions,legacyStableProfileOrder:existing.wireTelemetry.variant!=='intent-profile-prefix-v2'}})
            :existing.wireTelemetry?.variant==='reflection-prefix-v1'
              ?buildStagedReflectionMessages(packet,verified)
              :{applied:false,messages:wire?.messages??verified.messages};
          const providerMessages=toProviderMessages(staged.messages,{blobDirectory,packet,stagedHistory:staged.applied});
          return recoverOutputOnce({packet,primary:existing,ledger,client,verified,providerMessages,timeoutMs,startedAt,beforeCorrection,expectedPacketId:wire?.packetId??packet.packetId,...(wire?{formatIssue:raw=>intentFormatIssue(raw,wire)}:{})});
        }
        return selectedModelOutput(ledger.data.requests,existing).output;
      }
      return existing.output;
    }
    ensure(!existing||journalled&&existing.status==='reserved'&&existing.fingerprint===null,'TRANSPORT_REPLAY','request already attempted; never auto-resend');
    const verified=verifiedBeforeTransport(packet),wire=intentWire(packet),staged=prepareWireMessages(packet,verified,wire);
    const providerMessages=toProviderMessages(staged.messages,{blobDirectory,packet,stagedHistory:staged.applied});
    const bytes=Buffer.byteLength(JSON.stringify(providerMessages));
    const response=await client.call({id,packet:{...verified,payload:packet.payload,messages:providerMessages,bytes},requestContext:source?{source,packetId:packet.packetId}:null});
    ledger.attachProviderResult(id,response);
    if(typeof ledger.attachWireTelemetry==='function'){
      ledger.attachWireTelemetry(id,{
        wireLayout:staged.applied?'staged-v1':'legacy',fallback:staged.fallback===true,
        durationMs:response.latencyMs,firstContentMs:response.firstContentMs??null,preflightMs:response.preflightMs,
        preflightReused:response.preflightReused,stream:profile.upstreamSse===true,reportedModel:response.reportedModel??null,
        reasoning:profile.reasoning??'low',maxTokens:profile.maxTokens??3000,scene:packet?.payload?.current?.scene??null,
        ...(staged.meta?.variant?{variant:staged.meta.variant}:{}),
        ...(staged.meta?.anchorKey?{historyAnchor:staged.meta.anchorKey}:{}),
        sourceKind:source?.kind??(packet?.payload?.task?'task':packet?.payload?.current?'event':'reflection'),
        ...(packet.stage==='reflection'&&packet.payload?.internal?.kind!=='autonomy'?{reflectionProjection:packet.payload.continuity?.recent?.batchDelivery?.omittedEarlierTurns>0?'incremental':'full'}:{}),
        ...(staged.meta?{layer0Bytes:staged.meta.layer0Bytes??null,layer1Count:staged.meta.layer1Count??0,layer1Bytes:staged.meta.layer1Bytes??0,layer2Bytes:staged.meta.layer2Bytes??null,rolled:staged.meta.rolled===true}:{}),
      });
    }
    // JSON mode can replace an unrecognized JSON answer with spaces even with
    // finish_reason=stop (documented provider behavior). Treat this narrow,
    // fully-accounted case as a format error, not a network/content-filter retry.
    const blankJson=profile.formatRecovery===true&&response.finishReason==='stop'&&typeof response.output==='string'&&response.output.length>0&&response.output.trim().length===0;
    ensure(blankJson||response.complete===true&&typeof response.output==='string'&&response.output.trim().length>0,
      'MODEL_INCOMPLETE','provider returned no final text; recorded without retry');
    ledger.attachOutput(id,response.output);
    if(profile.formatRecovery===true){const formatIssue=wire?r=>intentFormatIssue(r,wire):r=>proposalFormatIssue(r,packet);const raw=await recoverOutputOnce({packet,primary:ledger.find(id),ledger,client,verified,providerMessages,timeoutMs,startedAt,beforeCorrection,expectedPacketId:wire?.packetId??packet.packetId,formatIssue});if(journalled&&formatIssue(raw))ledger.recordValidation(packet.packetId,{status:'rejected',error:'OUTPUT_FORMAT'});return raw;}
    return response.output;
  }
  async function invokeMaintenance(input){
    const id=`maintenance:${input.packetId}`;
    const existing=ledger.tryFind(id);
    if(existing?.status==='settled'&&typeof existing.output==='string')return existing.output;
    ensure(!existing,'TRANSPORT_REPLAY','maintenance request already attempted; never auto-resend');
    if(journalled)ensure(input.source?.kind==='maintenance','REQUEST_SOURCE','persisted maintenance job required');
    const messages=toProviderMessages(input.messages,{blobDirectory});
    const response=await maintenanceClient.call({id,packet:{messages,bytes:Buffer.byteLength(JSON.stringify(messages)),packetId:input.packetId},requestContext:journalled?{source:input.source,packetId:input.packetId}:null});
    ensure(response.complete===true&&typeof response.output==='string'&&response.output.trim().length>0,
      'MODEL_INCOMPLETE','provider returned no final maintenance text; recorded without retry');
    ledger.attachOutput(id,response.output);
    return response.output;
  }
  // This route shares the resident journal and can only call a text model.
  // It cannot originate an Event, Decision, note, task or host tool.
  const fastClient=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck:preflight,stream:true,
    maxTokens:Math.min(profile.maxTokens??3000,1024),timeoutMs,outputFormat:'text',reasoning:'off',
    inputVerifier:packet=>packet,admitRequest});
  async function invokeFastChat({requestKey,subjectId,identity,style='',messages,signal,onTextDelta}){
    ensure(journalled&&typeof requestKey==='string'&&/^[a-f0-9]{64}$/.test(requestKey)&&typeof subjectId==='string',
      'FAST_CHAT_JOURNAL','fast chat requires the current resident journal and key');
    ensure(Array.isArray(messages)&&messages.length>=1&&messages.length<=32&&messages.at(-1)?.role==='user'&&
      messages.every(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string'),
      'FAST_CHAT_INPUT','fast chat uses caller-provided plain-text turns');
    ensure(!messages.some(m=>redactSensitiveEgress(m.content).redacted||/-----BEGIN/i.test(m.content)),
      'FAST_CHAT_PRIVATE_INPUT','remove credentials before using fast chat');
    const system='Reply naturally in plain text. You only receive caller-provided conversation and the resident profile. You cannot use tools, access long-term memory, or save changes.\n'+identity+(style?'\n'+style:'');
    const wire=[{role:'system',content:system},...messages.map(({role,content})=>({role,content}))];
    const bytes=Buffer.byteLength(JSON.stringify(wire));
    ensure(bytes<=24_000,'FAST_CHAT_INPUT','fast chat has a 24 KB input limit');
    // A changed style or message cannot be mistaken for a replay of the previous result.
    const packetId=digest({route:'fast-chat-v1',subjectId,wire,maxTokens:fastClient.maxTokens});
    const id='fast-chat:'+requestKey, prior=ledger.tryFind(id);
    if(prior){
      ensure(prior.packetId===packetId,'IDEMPOTENCY_CONFLICT','fast chat key already bound to different input');
      ensure(prior.status==='settled'&&typeof prior.output==='string','GATEWAY_RESULT_UNAVAILABLE','original fast chat outcome must not be resubmitted');
      return {text:prior.output,usage:prior.usage};
    }
    const source={subject:subjectId,kind:'fast-chat',key:requestKey};
    const response=await fastClient.call({id,packet:{packetId,messages:wire,bytes},signal,onTextDelta,
      requestContext:{source,packetId}});
    ensure(response.complete,'MODEL_INCOMPLETE','fast chat did not finish normally');
    const text=redactSensitiveEgress(response.output).text.replace(/-----BEGIN[\s\S]*/i,'[REDACTED_PRIVATE_KEY]');
    ledger.attachOutput(id,text);
    ledger.attachWireTelemetry(id,{sourceKind:'fast-chat',durationMs:response.latencyMs,firstContentMs:response.firstContentMs,
      preflightMs:response.preflightMs,preflightReused:response.preflightReused,stream:true,reportedModel:response.reportedModel,
      reasoning:'off',maxTokens:fastClient.maxTokens});
    return {text,usage:response.usage};
  }
  async function invokeWork({requestKey,subjectId,body,signal}){
    ensure(journalled&&typeof requestKey==='string'&&/^[a-f0-9]{64}$/.test(requestKey)&&typeof subjectId==='string',
      'WORK_REQUEST','work channel requires its resident journal and request key');
    const validation=validateWorkApiRequest(body);
    ensure(validation.ok,'WORK_REQUEST',validation.message??'invalid work input');
    const maxTokens=profile.maxTokens??3000;
    const {upstream}=buildWorkChannelRequest({body:{...body,stream:false,max_tokens:maxTokens},upstreamModel:'deepseek-flash'});
    upstream.thinking={type:'disabled'};
    const bytes=Buffer.byteLength(JSON.stringify(upstream));
    ensure(bytes<=120_000,'WORK_REQUEST','work request exceeds 120 KB');
    const packetId=digest({kind:'work-v1',subjectId,upstream});
    const id='work:'+requestKey,prior=ledger.tryFind(id);
    if(prior){
      ensure(prior.packetId===packetId,'IDEMPOTENCY_CONFLICT','work request key already has different input');
      ensure(prior.status==='settled'&&typeof prior.output==='string','GATEWAY_RESULT_UNAVAILABLE','original work request cannot be resent');
      return JSON.parse(prior.output);
    }
    const source={subject:subjectId,kind:'work',key:requestKey};
    const response=await workClient.call({id,workRequest:upstream,packet:{packetId,messages:upstream.messages,bytes},signal,requestContext:{source,packetId}});
    const message=response.workMessage,calls=message?.tool_calls??[];
    ensure(Array.isArray(calls)&&calls.every(call=>Object.keys(call??{}).every(k=>['id','type','function'].includes(k))&&
      call.type==='function'&&typeof call.id==='string'&&call.id.length>0&&typeof call.function?.name==='string'&&
      typeof call.function?.arguments==='string'&&Object.keys(call.function).every(k=>['name','arguments'].includes(k)))&&new Set(calls.map(call=>call.id)).size===calls.length,
      'WORK_RESPONSE','provider returned malformed tool calls');
    const externalTools=new Set((upstream.tools??[]).map(tool=>tool.function.name));
    ensure(calls.every(call=>externalTools.has(call.function.name))&&!redactSensitiveEgress(JSON.stringify(calls)).redacted,
      'WORK_RESPONSE','provider returned unrequested tools or credential-like data');
    ensure(['stop','length','tool_calls','content_filter'].includes(response.finishReason)&&
      (response.finishReason==='tool_calls'?calls.length>0:calls.length===0),'WORK_RESPONSE','unexpected provider finish reason');
    ensure(typeof message?.content==='string'||message?.content===null&&(calls.length>0||response.finishReason==='content_filter'),'WORK_RESPONSE','missing provider response content');
    const output=sanitizeWorkChannelResponse({completionId:'chatcmpl-work-'+requestKey.slice(0,32),model:body.model,
      content:message.content===null?null:redactSensitiveEgress(message.content).text,toolCalls:calls,finishReason:response.finishReason,
      usage:{prompt_tokens:response.usage.prompt,completion_tokens:response.usage.completion,total_tokens:response.usage.prompt+response.usage.completion,
        prompt_cache_hit_tokens:response.usage.hit,prompt_cache_miss_tokens:response.usage.miss}});
    ledger.attachOutput(id,JSON.stringify(output));
    ledger.attachWireTelemetry(id,{sourceKind:'work',durationMs:response.latencyMs,stream:false,reportedModel:response.reportedModel,reasoning:'off',maxTokens});
    return output;
  }
  const workClient=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck:preflight,maxTokens:profile.maxTokens??3000,
    timeoutMs,outputFormat:'text',reasoning:'off',inputVerifier:packet=>packet,admitRequest});
  decide.requestJournal=journalled?ledger:null;
  decide.recordValidation=(packet,value)=>journalled?ledger.recordValidation(packet.packetId,value):null;
  return {decide,invokeMaintenance,invokeFastChat,invokeWork,ledger,state:()=>ledger.state(),close:()=>ledger.close()};
}

export const TRANSPORT_RATES=RATES;
