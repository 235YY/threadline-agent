import {gzipSync,gunzipSync} from 'node:zlib';
import {canonical,digest,ensure} from './contracts.mjs';

export const isTurnActivity = row => row.type==='extension_record'&&row.theory==='runtime'&&row.stateType==='turn-activity';
export const packetFields = row => ({
  decision:['input'], review:['input'], decision_attempt:['input'], affect_turn:['packet']
})[row.type]??(isTurnActivity(row)?['packet']:[]);

const isMap = value => value&&Object.getPrototypeOf(value)===Object.prototype;
const ledgerKeys=['requests','sources'];
export function packMotivation(row,previous){
  if(row.type!=='motivation_state'||!previous?.snapshot||((row.revision-1)%32===0))return row;
  const snapshot=row.snapshot;
  if(!ledgerKeys.every(key=>isMap(snapshot[key])&&isMap(previous.snapshot[key])))return row;
  const rest={...snapshot},changes={};
  for(const key of ledgerKeys){
    const prior=previous.snapshot[key],current=snapshot[key];
    changes[key]={
      put:Object.fromEntries(Object.entries(current).filter(([id,value])=>!Object.hasOwn(prior,id)||canonical(prior[id])!==canonical(value))),
      remove:Object.keys(prior).filter(id=>!Object.hasOwn(current,id))
    };
    delete rest[key];
  }
  const {snapshot: _full, ...record}=row;
  const packed={...record,$motivationDelta:{base:previous.revision,rest,changes}};
  return Buffer.byteLength(canonical(packed))<Buffer.byteLength(canonical(row))?packed:row;
}
export function unpackMotivation(row,read){
  if(!row.$motivationDelta)return row;
  const {base,rest,changes}=row.$motivationDelta;
  ensure(row.type==='motivation_state'&&base===row.revision-1&&base>0,'MOTIVATION_DELTA','snapshot base version is invalid');
  const previous=read(row.id,base);
  ensure(previous?.snapshot&&previous?.type===row.type,'MOTIVATION_DELTA','snapshot base is missing');
  const snapshot={...rest};
  for(const key of ledgerKeys){
    ensure(isMap(previous.snapshot[key])&&isMap(changes?.[key]?.put)&&Array.isArray(changes[key].remove),
      'MOTIVATION_DELTA','snapshot change is invalid');
    const removed=new Set(changes[key].remove);
    const retained=Object.fromEntries(Object.entries(previous.snapshot[key]).filter(([id])=>!removed.has(id)));
    snapshot[key]={...retained,...changes[key].put};
  }
  delete row.$motivationDelta;
  row.snapshot=snapshot;
  return row;
}

const fields=(row,convert)=>{
  if(row.type==='affect_turn'&&row.preview?.snapshot)
    row.preview={...row.preview,snapshot:convert(row.preview.snapshot)};
  if(isTurnActivity(row)){
    row.value={...row.value};
    for(const key of ['context','output','packet'])if(row.value[key]!==undefined)row.value[key]=convert(row.value[key]);
  }
  return row;
};
export function packLargeRuntimeFields(row){
  return fields({...row},value=>{
    const text=canonical(value),size=Buffer.byteLength(text);
    if(size<16384)return value;
    const bytes=gzipSync(text,{level:4}).toString('base64');
    if(bytes.length+130>=size)return value;
    return {$runtimeZip:bytes,sha:digest(text),size};
  });
}
export function unpackLargeRuntimeFields(row){
  return fields(row,value=>{
    if(!isMap(value)||!Object.hasOwn(value,'$runtimeZip'))return value;
    const text=gunzipSync(Buffer.from(value.$runtimeZip,'base64'),{maxOutputLength:value.size}).toString('utf8');
    ensure(Buffer.byteLength(text)===value.size&&digest(text)===value.sha,'RUNTIME_STORAGE','runtime record readback differs');
    return JSON.parse(text);
  });
}

