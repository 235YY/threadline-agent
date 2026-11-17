import {canonical,digest} from './contracts.mjs';
import {keepAttention} from './attention.mjs';
// Structural, lossless-to-audit adaptation only. No guessed beliefs, sources,
// state versions, tool grants, action choices, or evidence natures.
export function normalizeProposal(raw,packet){
  let value;try{value=typeof raw==='string'?JSON.parse(raw):JSON.parse(canonical(raw));}catch{return {value:raw,diagnostics:[]};}
  if(!value||Array.isArray(value)||typeof value!=='object')return {value:raw,diagnostics:[]};
  const diagnostics=[],strip=(obj,keys,path)=>{if(!obj||Array.isArray(obj)||typeof obj!=='object')return;for(const k of Object.keys(obj))if(!keys.includes(k)){diagnostics.push({path:path+'.'+k,code:'UNKNOWN_FIELD_IGNORED'});delete obj[k];}};
  strip(value,['packetId','options','selected','summary','used','continuity','apperception','affectAppraisal',...(packet.payload?.experienceLearning?.enabled===true?['lessons']:[])],'output');
  if(value.used==null){value.used=[];diagnostics.push({path:'used',code:'DEFAULT_NO_DECLARED_USE'});}
  const c=value.continuity;
  if(c&&typeof c==='object'&&!Array.isArray(c)){
    strip(c,['changes','residency','expressionChoice','observationDisposition','attention','attentionPolicy'],'continuity');
    for(const [key,fallback] of [['changes',[]],['residency',{add:[],remove:[]}],['expressionChoice',null],['attention',keepAttention()]]){
      if(!Object.hasOwn(c,key)&&!(key==='attention'&&!['decisionAttention','decisionMind','decisionGraph','reflection'].includes(packet.stage))&&!(packet.stage==='reflection'&&key==='expressionChoice')){c[key]=fallback;diagnostics.push({path:'continuity.'+key,code:'DEFAULT_NO_OPERATION'});}
    }
    strip(c.attention,['processes','relations','residency','questions','focus','frame','eventProcesses'],'continuity.attention');
    for(const [i,change]of (Array.isArray(c.changes)?c.changes:[]).entries()){
      strip(change,['id','expectedRevision','kind','body','status','scope','nature','reason','basis','mind','anchor','domains','about','stage'],`continuity.changes[${i}]`);
      if(change?.mind&&Object.hasOwn(change.mind,'basis')&&change.basis&&canonical(change.basis)===canonical(change.mind.basis)){
        delete change.mind.basis;diagnostics.push({path:`continuity.changes[${i}].mind.basis`,code:'EXACT_DUPLICATE_BASIS_REMOVED'});
      }
    }
  }
  for(const [i,o]of (Array.isArray(value.options)?value.options:[]).entries()){
    strip(o,['id','kind','payload','verb','args'],`options[${i}]`);
    // A reply cannot select a tool. Only this explicit null is equivalent to
    // omission; non-null tools, other payload fields and other kinds stay strict.
    if(o?.kind==='respond'&&o.payload&&Object.getPrototypeOf(o.payload)===Object.prototype
      &&typeof o.payload.text==='string'&&Object.hasOwn(o.payload,'tool')&&o.payload.tool===null){
      delete o.payload.tool;
      diagnostics.push({path:`options[${i}].payload.tool`,code:'ABSENT_EQUIVALENT_REPLY_TOOL_NULL_REMOVED',originalValue:null,reason:'reply-kind-has-no-tool-selection'});
    }
  }
  return {value,diagnostics};
}
export function normalizeAndRecord({store,packet,output}){
  const result=normalizeProposal(output,packet);
  const value=result.value,selected=Array.isArray(value?.options)?value.options.find(o=>o?.id===value.selected):null;
  if(['respond','wait','continue','pause','none','lookup'].includes(selected?.kind))for(const [i,c]of (Array.isArray(value.continuity?.changes)?value.continuity.changes:[]).entries()){
    if(c?.kind==='intention'&&c.expectedRevision===0&&typeof c.id==='string'&&c.id.startsWith('intent:')&&!store.read(c.id)){
      const outside={...value,continuity:{...value.continuity,changes:value.continuity.changes.filter((_,n)=>n!==i)}};
      if(!canonical(outside).includes(JSON.stringify(c.id))){const old=c.id;c.id='state:'+packet.payload.continuity.subject.id+':intention:'+digest({packet:packet.packetId,id:old});result.diagnostics.push({path:`continuity.changes[${i}].id`,code:'NEW_STATE_TECHNICAL_ID_ALLOCATED',originalId:old,normalizedId:c.id});}
    }
  }
  if(result.diagnostics.length){
    const id='extension:'+packet.payload.continuity.subject.id+':runtime:proposal:'+digest({packet:packet.packetId,output});
    if(!store.read(id))store.execute({requestId:id,commands:[{op:'put_extension_record',id,owner:packet.payload.continuity.subject.id,theory:'runtime',stateType:'proposal-normalization',schemaVersion:'1',expectedRevision:0,value:{packetId:packet.packetId,rawOutput:output,normalized:result.value,diagnostics:result.diagnostics}}]});
  }
  return result.value;
}
