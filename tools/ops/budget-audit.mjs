// Read-only cumulative budget audit. Dedupe by stable request id; never resets or writes a ledger.
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {auditResetBudget} from './reset-budget-contract.mjs';
import {auditContinuation} from '../../src/budget-continuation.mjs';

export function auditBudgets(dir='_local/brain'){
const continuation=auditContinuation(dir);if(continuation)return continuation;
const reset=auditResetBudget(dir);if(reset)return reset;
if(!existsSync(dir))return {format:'jingyang-cumulative-budget-audit-v1',sources:[],uniqueCalls:0,calls:0,settledCalls:0,unknownCalls:0,conflictCount:0,micros:0,authorization:{maxCalls:50,maxMicros:6000000},within:false,error:'NO_LEDGER',note:'no cumulative ledger in this directory; live start refused'};
const files=readdirSync(dir).filter(n=>n.endsWith('.json')&&!n.includes('cumulative-budget')).sort();
const byKey=new Map(),idFingerprints=new Map(),prefixFingerprints=new Map();
const sources=[];
let conflictCount=0,authorization=null;
for(const name of files){
  let data;try{data=JSON.parse(readFileSync(join(dir,name),'utf8'));}catch{continue;}
  if(!Array.isArray(data.requests))continue;
  if(data.authorization&&data.authorization.maxMicros>=10000000&&data.authorization.maxCalls>=1000)authorization=data.authorization;
  sources.push({name,requests:data.requests.length,halted:data.halted??null,dayKey:data.dayKey??null});
  for(const request of data.requests){
    if(!request?.id)continue;
    const key=request.id+'|'+(request.fingerprint??'no-fingerprint');
    const id=request.id;if(!idFingerprints.has(id))idFingerprints.set(id,new Set());idFingerprints.get(id).add(request.fingerprint??'no-fingerprint');
    const prefix=String(id).split(':').slice(0,2).join(':');if(!prefixFingerprints.has(prefix))prefixFingerprints.set(prefix,new Set());prefixFingerprints.get(prefix).add(request.fingerprint??'no-fingerprint');
    const prior=byKey.get(key);
    if(prior){if(prior.status!==request.status||prior.actualMicros!==(request.actualMicros??null)||prior.reserveMicros!==(request.reserveMicros??null))conflictCount++;prior.sources.push(name);continue;}
    byKey.set(key,{key,id,status:request.status??'unknown',actualMicros:request.actualMicros??null,reserveMicros:request.reserveMicros??null,fingerprint:request.fingerprint??null,sources:[name]});
  }
}
const requests=[...byKey.values()];
const idCollisions=[...idFingerprints.entries()].filter(([,set])=>set.size>1).length;
const prefixCollisions=[...prefixFingerprints.entries()].filter(([,set])=>set.size>1).map(([prefix,set])=>({prefix,fingerprints:set.size}));
conflictCount+=idCollisions;
const settled=requests.filter(r=>r.status==='settled'&&Number.isSafeInteger(r.actualMicros)&&r.actualMicros>=0);
const unknown=requests.filter(r=>!settled.includes(r));
const micros=settled.reduce((a,r)=>a+r.actualMicros,0);
const noHistory=sources.length===0||(requests.length===0&&!authorization);
const caps=authorization?{maxCalls:authorization.maxCalls,maxMicros:authorization.maxMicros}:{maxCalls:50,maxMicros:6000000};
return {format:'jingyang-cumulative-budget-audit-v1',sources,uniqueCalls:requests.length,calls:requests.length,settledCalls:settled.length,unknownCalls:unknown.length,conflictCount,idCollisions,prefixCollisions,micros,authorization:caps,within:!noHistory&&requests.length<=caps.maxCalls&&Number.isSafeInteger(micros)&&micros<=caps.maxMicros&&unknown.length===0&&conflictCount===0,error:noHistory?'NO_VERIFIABLE_HISTORY':undefined,note:'no history is not zero; unknown cost is not zero; duplicates are not double-counted'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=auditBudgets(process.argv.includes('--dir')?process.argv[process.argv.indexOf('--dir')+1]:'_local/brain');console.log(JSON.stringify(result,null,2));if(process.argv.includes('--strict')&&(!result.within))process.exit(2);}
