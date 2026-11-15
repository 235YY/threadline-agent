// Explicit operator-approved continuation. History is immutable; only new unknown
// requests stop this run. The permitted old reservations remain fully charged.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,ensure} from './contracts.mjs';
import {validateBudgetRows} from './budget-integrity.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function continuationAuthorization(path){
  const file=path+'.continuation.json';if(!existsSync(file))return null;
  const a=JSON.parse(readFileSync(file,'utf8')),dir=resolve(dirname(path));
  ensure(!existsSync(path+'.reset.json')&&a.format==='jingyang-authorized-continuation-v1'&&[5000000,10000000].includes(a.totalLimitMicros)&&a.maxCalls===null&&a.unknownCarryApproved===true,'BUDGET_POLICY','explicit continuation required; 10 yuan additionally requires a bound expansion grant');
  ensure(a.instruction==='保留全额预留并继续上线'&&Number.isSafeInteger(a.approvedAt)&&Number.isSafeInteger(a.validUntil)&&a.validUntil>a.approvedAt&&a.validUntil-a.approvedAt<=86400000,'BUDGET_POLICY','bounded explicit authorization required');
  const read=row=>{const p=resolve(dir,row.file);ensure(p.startsWith(dir+sep),'BUDGET_POLICY','history must remain within budget directory');const bytes=readFileSync(p);ensure(hash(bytes)===row.sha256,'BUDGET_POLICY','frozen accounting evidence changed');return JSON.parse(bytes);};
  const prior=read(a.priorLedger),carry=read(a.carry);validateBudgetRows(prior.requests);validateBudgetRows(carry.requests);
  for(const r of a.sources??[])read(r);
  let expansionPrior=null;
  if(a.totalLimitMicros===10000000){
    ensure(a.expansion?.format==='jingyang-cumulative-expansion-v1','BUDGET_POLICY','10-yuan limit cannot self-authorize');
    const grant=read(a.expansion.authorization),old=read(a.expansion.previousAuthorization);expansionPrior=read(a.expansion.priorLedger);
    ensure(grant.format==='jingyang-explicit-budget-grant-v1'&&grant.previousTotalMicros===5000000&&grant.totalLimitMicros===10000000&&typeof grant.userInstruction==='string'&&grant.userInstruction.trim().length>0&&Number.isSafeInteger(grant.approvedAt)&&grant.validUntil===a.validUntil,'BUDGET_POLICY','bound explicit grant required');
    ensure(old.format===a.format&&old.totalLimitMicros===5000000&&old.dayKey===a.dayKey&&old.validUntil>=a.validUntil&&grant.approvedAt>=old.approvedAt&&grant.approvedAt<a.validUntil&&canonical(old.carry)===canonical(a.carry)&&canonical(old.priorLedger)===canonical(a.priorLedger)&&canonical(old.sources??[])===canonical(a.sources??[]),'BUDGET_POLICY','expansion must preserve prior authorization and every carry source');
    validateBudgetRows(expansionPrior.requests);
    ensure(expansionPrior.format==='jingyang-daily-brain-budget-v1'&&expansionPrior.dayKey===a.dayKey&&expansionPrior.dailyMicros===old.activeLimitMicros&&expansionPrior.dailyCalls===null&&!expansionPrior.halted&&expansionPrior.requests.every(r=>['settled','released'].includes(r.status)),'BUDGET_POLICY','expansion cannot clear a stop or grandfather new unknown spend');
  }
  const ids=new Set(prior.requests.map(r=>r.id));ensure(carry.requests.every(r=>!ids.has(r.id)),'BUDGET_POLICY','carried history must not duplicate active rows');
  const held=validateBudgetRows(carry.requests).held;ensure(Number.isSafeInteger(held)&&held<a.totalLimitMicros&&a.activeLimitMicros===a.totalLimitMicros-held,'BUDGET_POLICY','active allowance must deduct all frozen carried costs');
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(a.dayKey),'BUDGET_POLICY','phase day required');
  return {...a,prior,expansionPrior,carried:carry.requests,held};
}
export function verifyContinuationLedger(data,a){
  ensure(data.dayKey===a.dayKey&&data.dailyCalls===null&&data.dailyMicros===a.activeLimitMicros,'BUDGET_POLICY','continuation limits changed');
  validateBudgetRows(data.requests);
  ensure(data.requests.length>=a.prior.requests.length&&a.prior.requests.every((r,i)=>canonical(r)===canonical(data.requests[i])),'BUDGET_POLICY','prior active history changed');
  if(a.expansionPrior)ensure(data.requests.length>=a.expansionPrior.requests.length&&a.expansionPrior.requests.every((r,i)=>canonical(r)===canonical(data.requests[i])),'BUDGET_POLICY','pre-expansion requests cannot be changed or deleted');
  const carriedIds=new Set(a.carried.map(r=>r.id));ensure(data.requests.every(r=>!carriedIds.has(r.id)),'ALREADY_REQUESTED','carried request cannot replay');
}
export function auditContinuation(dir){
  const path=resolve(dir,'budget.json');if(!existsSync(path+'.continuation.json'))return null;
  try{
    const a=continuationAuthorization(path),data=JSON.parse(readFileSync(path,'utf8'));verifyContinuationLedger(data,a);
    const settled=data.requests.filter(r=>r.status==='settled'),unknown=data.requests.filter(r=>!['settled','released'].includes(r.status));
    const micros=settled.reduce((n,r)=>n+r.actualMicros,0),reserved=unknown.reduce((n,r)=>n+r.reserveMicros,0);
    return {format:'jingyang-cumulative-budget-audit-v1',calls:data.requests.length+a.carried.length,settledCalls:settled.length,unknownCalls:unknown.length,conflictCount:0,micros:micros+a.held,reservedMicros:reserved,authorization:{maxCalls:null,maxMicros:a.totalLimitMicros,validUntil:a.validUntil},historical:{calls:a.carried.length,heldMicros:a.held,approvedUnknownCalls:a.carried.filter(r=>!['settled','released'].includes(r.status)).length},within:Date.now()<a.validUntil&&!data.halted&&unknown.length===0&&micros+reserved<=a.activeLimitMicros};
  }catch(error){return {within:false,unknownCalls:1,error:error.code??'BUDGET_POLICY'};}
}
