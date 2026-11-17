import {canonical,digest,ensure,text} from './contracts.mjs';
import {initializeSubject,admitSubjectEvent} from './continuity.mjs';
import {prepareDecision,prepareReflection,commitDecision,verifiedModelInput} from './cognition.mjs';
import {attentionId} from './attention.mjs';
import {packetContext,failureMetadata,outputMetrics} from './debug-contract.mjs';
import {normalizeAndRecord} from './proposal-normalization.mjs';
import {intentEligible,looksLikeIntent,intentWireFor,expandIntent} from './intent-protocol.mjs';

// An intent-protocol answer is compiled into the full output before the ordinary commit.
// The raw answer and its compilation are kept for audit; nothing else changes downstream.
function compileIntentOutput({store,packet,output}){
  if(!intentEligible(packet)||!looksLikeIntent(output))return output;
  const raw=typeof output==='string'?output:canonical(output),wire=intentWireFor(packet,JSON.parse(raw).packetId);
  ensure(wire,'WRONG_PACKET','intent answer does not match any intent packet for this input');
  const diagnostics=[],compiled=expandIntent(wire,raw,{store,diagnostics}),subject=packet.payload.continuity.subject.id;
  const id='extension:'+subject+':runtime:intent:'+digest({packet:packet.packetId,raw});
  if(!store.read(id))store.execute({requestId:id,commands:[{op:'put_extension_record',id,owner:subject,theory:'runtime',stateType:'intent-compilation',schemaVersion:'1',expectedRevision:0,value:{packetId:packet.packetId,intentPacketId:wire.packetId,rawOutput:raw,compiled,diagnostics}}]});
  return compiled;
}

// One request in, one decision out. The injected client owns metering and provider configuration.
// There is no default provider, key loader, automatic retry, autonomous loop, or QQ sender here.
export class ContinuitySession {
  #store; #subjectId; #pending=new Map(); #requestJournal;
  constructor({store,subjectId,maxForeground=8,attention=false,requestJournal=null}) {
    text(subjectId,'subject id');this.#store=store;this.#subjectId=subjectId;
    this.#requestJournal=requestJournal;
    initializeSubject({store,subjectId,maxForeground,requestId:`subject-session:${subjectId}`});
    ensure(typeof attention==='boolean','INVALID_INPUT','attention must be explicit boolean');
    if(attention)store.execute({requestId:`initialize:${attentionId(subjectId)}`,commands:[{op:'initialize_attention',subjectId}]});
  }
  invoke(packet,fn){return fn(packet);}
  sourceBlocked(eventId){const event=this.#store.read(eventId);return !!event&&this.#requestJournal?.blocks({subject:this.#subjectId,kind:'event',event:{id:event.id,revision:event.revision}})===true;}
  prepareReflection(args){return prepareReflection({...args,store:this.#store,subjectId:this.#subjectId});}
  prepare(args) {
    ensure(args&&args.subjectId===undefined,'SUBJECT_FIXED','session subject cannot be changed per activity');
    admitSubjectEvent({store:this.#store,subjectId:this.#subjectId,event:args.currentEvent,
      requestId:`subject-admission:${digest({subjectId:this.#subjectId,event:args.currentEvent})}`});
    const packet=prepareDecision({...args,store:this.#store,subjectId:this.#subjectId});
    this.#store.notifyForeground({subjectId:this.#subjectId,packetId:packet.packetId,subject:packet.payload.continuity.subject,attention:packet.payload.continuity.attention?.frame});
    return packet;
  }
  commit(args) {
    ensure(['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection'].includes(args.packet?.stage)&&args.packet.payload.continuity.subject.id===this.#subjectId,'SUBJECT_FIXED','input belongs to another subject/session');
    let output,d;
    try{const attempt=this.#requestJournal?.packetRequest(args.packet.packetId);ensure(!attempt||attempt.status==='settled'&&attempt.validation?.status!=='rejected','REQUEST_VALIDATION_CONFLICT','request must have a settled, unrejected output before adoption');output=normalizeAndRecord({store:this.#store,packet:args.packet,output:compileIntentOutput({store:this.#store,packet:args.packet,output:args.output})});d=commitDecision({...args,output,store:this.#store});}
    catch(error){
      if(error.name==='ContractError'&&!this.#requestJournal?.packetRequest(args.packet.packetId)?.validation)this.#requestJournal?.recordValidation(args.packet.packetId,{status:'rejected',error:error.code});
      if(['STATE_CONFLICT','UNDELIVERED_REFERENCE','WRONG_OBJECT_KIND','ID_COLLISION','UNREAD_STATE','INTENT_OPTION','INTENT_HANDLE','INTENT_SHAPE','INTENT_LIMIT','TOOL_NOT_GRANTED'].includes(error.code)){
        const id='extension:'+this.#subjectId+':runtime:validation:'+digest({packet:args.packet.packetId,output:output??args.output,code:error.code});
        if(!this.#store.read(id))this.#store.execute({requestId:id,commands:[{op:'put_extension_record',id,owner:this.#subjectId,theory:'runtime',stateType:'operation-feedback',schemaVersion:'1',expectedRevision:0,value:{stage:'validation',sourceEvent:args.packet.payload.current?.id??null,packetId:args.packet.packetId,error:error.code,message:error.message,details:error.details??{},adopted:false,execution:'not-started',next:'上次提案未提交。按当前交付目录自主重新判断；不自动重放，不替你修订内容。'}}]});
      }
      throw error;
    }
    this.#requestJournal?.recordValidation(args.packet.packetId,{status:'accepted',decision:{id:d.id,revision:d.revision}});
    return d;
  }
  closeRejected({packet,error,journal}){
    if(error.name!=='ContractError'&&this.#requestJournal?.packetRequest(packet.packetId)?.validation?.status!=='rejected')return false;
    const commands=[];
    if(packet.payload.current)commands.push({op:'quarantine_source',subject:{id:this.#subjectId,revision:this.#store.read(this.#subjectId).revision},event:{id:packet.payload.current.id,revision:packet.payload.current.revision},reason:error.code});
    commands.push(journal);
    this.#store.execute({requestId:'reject-completed:'+packet.packetId,commands});return true;
  }
  run(args) {
    text(args?.requestId,'request id');text(args?.decisionId,'decision id');
    const {invoke,...content}=args,key=digest(content),existing=this.#pending.get(args.decisionId);
    if(existing){ensure(existing.key===key,'DECISION_ID_COLLISION','in-flight invocation changed content');return existing.promise;}
    const promise=this.#run(args).finally(()=>this.#pending.delete(args.decisionId));
    this.#pending.set(args.decisionId,{key,promise});return promise;
  }
  async #run({invoke,requestId,decisionId,maxOutputBytes=16384,...prepareArgs}) {
    ensure(typeof invoke==='function','MODEL_CLIENT_REQUIRED','provide an explicitly metered model client');
    text(requestId,'request id');text(decisionId,'decision id');
    ensure(prepareArgs.subjectId===undefined,'SUBJECT_FIXED','session subject cannot be changed per activity');
    const invocationKey=digest({requestId,decisionId,currentEvent:prepareArgs.currentEvent,workspace:prepareArgs.workspace,
      identity:prepareArgs.identity??'',materials:prepareArgs.materials??[],previousDecisions:prepareArgs.previousDecisions??[],
      allowedActionTools:prepareArgs.allowedActionTools??[],stateRefs:prepareArgs.stateRefs??[],stateDetail:prepareArgs.stateDetail??false,
      ...(prepareArgs.lookupResults?.length?{lookupResults:prepareArgs.lookupResults}:{}),
      ...(prepareArgs.localLookupPolicy?{localLookupPolicy:prepareArgs.localLookupPolicy}:{}),
      mind:prepareArgs.mind??false,...(prepareArgs.investigationContinuityV1?{investigationContinuityV1:true}:{}),...(prepareArgs.instructionSuffix?{instructionSuffix:prepareArgs.instructionSuffix}:{}),...(prepareArgs.unified?{unified:true}:{}),...(prepareArgs.waitSupport?{waitSupport:true}:{}),...(prepareArgs.consultation?{consultation:true}:{}),
      ...(prepareArgs.consultationProgress?{consultationProgress:true}:{}),...(prepareArgs.workbenchMaterials?{workbenchMaterials:true}:{}),...(prepareArgs.workbenchFocus?{workbenchFocus:true}:{}),...(prepareArgs.workbenchRecovery?{workbenchRecovery:true}:{}),...(prepareArgs.algorithmV011?{algorithmV011:true}:{}),...(prepareArgs.apperceptionV1?{apperceptionV1:true}:{}),...(prepareArgs.subjectiveDomains?{subjectiveDomains:true}:{}),...(prepareArgs.subjectiveMemory?{subjectiveMemory:true}:{}),...(prepareArgs.subjectiveMemoryV2?{subjectiveMemoryV2:true}:{}),...(prepareArgs.taskThreads?{taskThreads:true}:{}),...(prepareArgs.anchorDirectory?{anchorDirectory:true}:{}),budgetBytes:prepareArgs.budgetBytes??null,maxOutputBytes});
    // Deterministic completed-turn resume avoids a second provider request after a committed turn.
    const existing=this.#store.read(decisionId);
    if(existing){
      ensure(existing.type==='decision'&&existing.invocationKey===invocationKey&&existing.requestKey===requestId&&existing.input.payload.continuity?.subject.id===this.#subjectId
        && existing.currentEvent.id===prepareArgs.currentEvent.id&&existing.currentEvent.revision===prepareArgs.currentEvent.revision
        && existing.workspace.id===prepareArgs.workspace.id&&existing.workspace.revision===prepareArgs.workspace.revision,
        'DECISION_ID_COLLISION','cannot reuse a decision id for another request');
      this.#store.recordDiagnostic({stage:'run.resumed',status:'replayed',context:packetContext(existing.input,{decisionId}),data:{modelCalled:false,reason:'committed-decision'}});
      return {decision:existing,packet:existing.input,resumed:true,modelCalled:false};
    }
    const pending=this.#store.read(`${decisionId}:attempt`);
    if(pending){
      ensure(pending.type==='decision_attempt'&&pending.invocationKey===invocationKey&&pending.requestKey===requestId
        &&pending.input.payload.continuity?.subject.id===this.#subjectId,'DECISION_ID_COLLISION','captured proposal belongs to another invocation');
      this.#store.recordDiagnostic({stage:'run.resumed',status:'replayed',context:packetContext(pending.input,{decisionId}),data:{modelCalled:false,reason:'captured-proposal'}});
      return {decision:null,attempt:pending,packet:pending.input,status:'pending-proposal',resumed:true,modelCalled:false};
    }
    const packet=this.prepare(prepareArgs);
    const context=packetContext(packet,{decisionId,requestId}),start=performance.now();
    this.#store.recordDiagnostic({stage:'model.started',status:'started',context,data:{modelCalled:true,bytes:packet.bytes}});
    let response;
    try{response=await invoke(verifiedModelInput(packet));}
    catch(error){this.#store.recordDiagnostic({stage:'model.failed',status:'uncertain',context,data:{...failureMetadata(error,{client:true}),durationMs:Math.round(performance.now()-start)}});throw error;}
    this.#store.recordDiagnostic({stage:'model.completed',status:'completed',context,data:{...outputMetrics(response),durationMs:Math.round(performance.now()-start)}});
    try{ensure(typeof response==='string'||response&&Object.getPrototypeOf(response)===Object.prototype,'MODEL_OUTPUT_REQUIRED','client must return final JSON text or parsed output, never private reasoning');}
    catch(error){this.#store.recordDiagnostic({stage:'model.output-rejected',status:'rejected',context,data:failureMetadata(error)});throw error;}
    const decision=this.commit({packet,output:response,requestId,decisionId,maxOutputBytes,allowedActionTools:prepareArgs.allowedActionTools??[],invocationKey});
    return {packet,decision,resumed:false,modelCalled:true};
  }
}
