import {validateBudgetRows} from '../../src/budget-integrity.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const requireValue=(value,message)=>{if(!value)throw Object.assign(Error(message),{code:'BUDGET_RESET_INVALID'});};
export function resetAuthorization(ledgerPath){
 const file=ledgerPath+'.reset.json';if(!existsSync(file))return null;
 const g=JSON.parse(readFileSync(file,'utf8')),dir=resolve(dirname(ledgerPath));
 requireValue(g.format==='jingyang-budget-reset-v1'&&g.ledgerFile===basename(ledgerPath),'invalid reset marker');
 requireValue(typeof g.phaseId==='string'&&g.phaseId.length>0&&/^\d{4}-\d{2}-\d{2}$/.test(g.dayKey),'reset identity required');
 requireValue(g.maxCalls===20&&g.maxMicros===2000000&&g.instruction==='账本直接清空，从零开始记。','reset exceeds authorized retained limits');
 const archive=resolve(dir,g.previous.archiveFile);
 requireValue(archive.startsWith(dir+sep)&&archive!==resolve(ledgerPath),'archive must remain inside this budget directory');
 const bytes=readFileSync(archive);requireValue(sha(bytes)===g.previous.sha256,'prior budget archive changed');
 const prior=JSON.parse(bytes);requireValue(Array.isArray(prior.requests),'prior budget history missing');
 if(g.amendment){const a=g.amendment;
  requireValue(a.instruction==='并且20条太少了，今天先不限制多少条，只限制预算5元'&&a.maxCalls===null&&a.maxMicros===5000000,'invalid budget-only amendment');
  const before=resolve(dir,a.previousGrantFile);requireValue(before.startsWith(dir+sep)&&sha(readFileSync(before))===a.previousGrantSha256,'prior authorization changed');
  requireValue(Number.isSafeInteger(a.validUntil)&&Number.isSafeInteger(a.approvedAt)&&a.validUntil>a.approvedAt&&a.validUntil-a.approvedAt<=86400000,'bounded today authorization required');
  return {...g,maxCalls:null,maxMicros:5000000,validUntil:a.validUntil,previousData:prior};
 }
 return {...g,previousData:prior};
}
export function verifyResetLedger(data,g){
 requireValue(data.format==='jingyang-daily-brain-budget-v1'&&data.resetPhaseId===g.phaseId&&data.dayKey===g.dayKey,'current ledger differs from reset phase');
 requireValue(data.dailyCalls===g.maxCalls&&data.dailyMicros===g.maxMicros&&Array.isArray(data.requests),'reset limits changed');
 validateBudgetRows(data.requests);
 const previous=new Set(g.previousData.requests.map(r=>r.id));
 requireValue(data.requests.every(r=>!previous.has(r.id)),'old request was replayed after reset');
 return true;
}
export function auditResetBudget(dir){
 const path=resolve(dir,'budget.json');if(!existsSync(path+'.reset.json'))return null;
 try{
  const g=resetAuthorization(path),data=JSON.parse(readFileSync(path,'utf8'));verifyResetLedger(data,g);
  const rows=data.requests,settled=rows.filter(r=>r.status==='settled'&&Number.isSafeInteger(r.actualMicros)&&r.actualMicros>=0),unknown=rows.filter(r=>!settled.includes(r)&&r.status!=='released');
  const cost=settled.reduce((a,r)=>a+r.actualMicros,0),reserved=unknown.reduce((a,r)=>a+(r.reserveMicros??g.maxMicros),0);
  const priorUnknown=g.previousData.requests.filter(r=>!['settled','released'].includes(r.status));
  return {format:'jingyang-cumulative-budget-audit-v1',resetPhaseId:g.phaseId,calls:rows.length,uniqueCalls:rows.length,settledCalls:settled.length,unknownCalls:unknown.length,conflictCount:0,micros:cost,reservedMicros:reserved,authorization:{maxCalls:g.maxCalls,maxMicros:g.maxMicros,validUntil:g.validUntil??null},sources:[{name:'budget.json',requests:rows.length}],historical:{archive:g.previous.archiveFile,sha256:g.previous.sha256,calls:g.previousData.requests.length,unknownCalls:priorUnknown.length,unknownReservedMicros:priorUnknown.reduce((a,r)=>a+r.reserveMicros,0)},within:!data.halted&&(g.validUntil===undefined||Date.now()<g.validUntil)&&(g.maxCalls===null||rows.length<=g.maxCalls)&&cost+reserved<=g.maxMicros&&unknown.length===0,note:'User explicitly reset current counters; archived charges and unknown costs remain historical obligations. Empty authorized phase is valid; prior requests cannot replay.'};
 }catch(e){return {format:'jingyang-cumulative-budget-audit-v1',within:false,error:e.code??'BUDGET_RESET_INVALID',message:e.message,calls:0,micros:0,unknownCalls:1,conflictCount:1};}
}
