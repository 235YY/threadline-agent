import {ensure} from './contracts.mjs';

export function validateBudgetRows(rows){
  ensure(Array.isArray(rows),'BUDGET_CORRUPT','request history must be an array');const ids=new Set();let held=0;
  for(const r of rows){
    ensure(r&&typeof r.id==='string'&&r.id.length>0&&!ids.has(r.id),'BUDGET_CORRUPT','request identities missing or duplicated');ids.add(r.id);
    ensure(['reserved','dispatched','settled','uncertain','released'].includes(r.status),'BUDGET_CORRUPT','unrecognized request state');
    ensure(Number.isSafeInteger(r.reserveMicros)&&r.reserveMicros>0,'BUDGET_CORRUPT','positive safe reservation required');
    if(r.status==='settled')ensure(Number.isSafeInteger(r.actualMicros)&&r.actualMicros>=0,'BUDGET_CORRUPT','settled cost must be a nonnegative safe integer');
    held+=r.status==='settled'?r.actualMicros:r.status==='released'?0:r.reserveMicros;
    ensure(Number.isSafeInteger(held),'BUDGET_CORRUPT','budget total exceeds safe arithmetic');
  }
  return {held};
}
