import {existsSync,readFileSync} from 'node:fs';import {resolve,dirname,sep} from 'node:path';import {createHash} from 'node:crypto';
import {canonical,ensure} from './contracts.mjs';import {validateBudgetRows} from './budget-integrity.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),unknown=r=>!['settled','released'].includes(r.status);
export function billingRates(now){
 const inPeak=time=>{const local=new Date(time+8*3600000),weekday=local.getUTCDay(),hour=local.getUTCHours();return weekday>=1&&weekday<=5&&(hour>=9&&hour<12||hour>=14&&hour<18);};
 // Weekday holiday exceptions without a verified calendar remain a peak upper
 // bound. Weekends and hours outside the published windows are known off-peak.
 const peak=inPeak(now)||inPeak(now+120000);
 return {hit:peak?0.04:0.02,miss:peak?2:1,output:peak?8:4,period:peak?'peak-upper':'off-peak',source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'};
}
export function tokenCharge(usage,rates){
 if(!usage||!rates||![usage.prompt,usage.completion,usage.hit,usage.miss].every(Number.isSafeInteger)||usage.hit+usage.miss!==usage.prompt)return null;
 ensure([0.02,0.04].includes(rates.hit)&&[1,2].includes(rates.miss)&&[4,8].includes(rates.output),'BUDGET_RATE','unrecognized frozen Flash rates');
 return Math.ceil((usage.hit*Math.round(rates.hit*100)+usage.miss*rates.miss*100+usage.completion*rates.output*100)/100);
}
export function beijingDay(now=Date.now()){
 ensure(Number.isSafeInteger(now)&&now>=0,'BUDGET_CLOCK','valid wall time required');
 return new Date(now+8*3600000).toISOString().slice(0,10);
}
export function dailySpendPolicy(path){
 const file=path+'.daily.json';if(!existsSync(file))return null;
 const bytes=readFileSync(file),a=JSON.parse(bytes),base=resolve(dirname(path));
 ensure(a.format==='jingyang-standing-daily-spend-v1'&&a.dailyMicros===5000000&&a.maxCalls===null&&a.timeZone==='Asia/Shanghai'&&a.standing===true&&typeof a.userInstruction==='string'&&a.userInstruction.trim()&&Number.isSafeInteger(a.approvedAt),'BUDGET_POLICY','explicit standing 5-yuan authorization required');
 ensure(!existsSync(path+'.reset.json')&&!existsSync(path+'.continuation.json'),'BUDGET_POLICY','cannot mix budget authorization modes');
 const frozen=r=>{const p=resolve(base,r.file);ensure(p.startsWith(base+sep),'BUDGET_POLICY','frozen accounting must stay inside the budget directory');const b=readFileSync(p);ensure(sha(b)===r.sha256,'BUDGET_POLICY','frozen accounting changed');return b;};
 const evidence=r=>JSON.parse(frozen(r)),load=r=>{const v=evidence(r);validateBudgetRows(v.requests);return v;};
 const initial=load(a.initialLedger);ensure(initial.format==='jingyang-daily-brain-budget-v1'&&initial.dayKey===beijingDay(a.approvedAt),'BUDGET_POLICY','initial day must match the explicit approval day');
 const initialIds=new Set(initial.requests.map(r=>r.id)),history=new Map();
 for(const source of a.history??[]){const value=load(source);let day=null;
  if(source.kind==='dated'){ensure(/^\d{4}-\d{2}-\d{2}$/.test(source.day)&&source.day<=initial.dayKey,'BUDGET_POLICY','historical day required');day=source.day;}
  else ensure(source.kind==='before-initial-day'&&Number.isSafeInteger(source.recordedBefore)&&beijingDay(source.recordedBefore)<initial.dayKey,'BUDGET_POLICY','undated old settlements require frozen pre-day evidence');
  for(const row of value.requests){ensure(!initialIds.has(row.id),'BUDGET_POLICY','history cannot charge the active row twice');const old=history.get(row.id);ensure(!old||canonical(old.row)===canonical(row)&&old.day===day,'BUDGET_POLICY','conflicting historical accounting');history.set(row.id,{row,day});}
 }
 let amendment=null,reconciliation=null;
 if(a.amendment){const previous=evidence(a.amendment.previousPolicy),ledger=load(a.amendment.previousLedger);
  ensure(previous.format===a.format&&previous.dailyMicros===a.dailyMicros&&previous.maxCalls===a.maxCalls&&previous.timeZone===a.timeZone&&previous.standing===a.standing&&canonical(previous.initialLedger)===canonical(a.initialLedger)&&canonical(previous.history)===canonical(a.history),'BUDGET_POLICY','billing correction cannot expand permission or alter historical accounting');
  amendment={hash:a.amendment.previousPolicy.sha256,ledger};
 }
 if(a.reconciliation){const value=evidence(a.reconciliation),provider=value.provider;validateBudgetRows(value.knownRows);validateBudgetRows(value.excludedRows);
  ensure(value.format==='jingyang-provider-day-reconciliation-v1'&&provider.day===initial.dayKey&&provider.apiKeyLabel==='Threadline Agent'&&value.knownRows.every(r=>r.status==='settled')&&value.excludedRows.every(r=>r.status==='settled'),'BUDGET_RECONCILIATION','known settled rows and a fixed provider/day scope required');
  frozen(provider.screenshot);
  const rates=billingRates(Date.parse(provider.day+'T12:00:00+08:00'));ensure(rates.period==='off-peak','BUDGET_RECONCILIATION','this aggregate reconciliation requires a full off-peak day');
  let tokens=0,cost=0;const known=new Map();for(const r of value.knownRows){const charge=tokenCharge(r.usage,rates);ensure(charge!==null,'BUDGET_RECONCILIATION','complete raw token usage required');tokens+=r.usage.prompt+r.usage.completion;cost+=charge;known.set(r.id,{row:r,charge});}
  ensure(provider.calls===known.size&&provider.tokens===tokens&&Number((cost/1e6).toFixed(2))===provider.displayCny,'BUDGET_RECONCILIATION','calls, tokens and amount must all match the provider screenshot');
  const excluded=new Map(value.excludedRows.map(r=>[r.id,r]));ensure([...excluded.keys()].every(id=>!known.has(id)),'BUDGET_RECONCILIATION','reconciled calls cannot also be excluded');
  reconciliation={day:provider.day,known,excluded,provider,cost};
 }
 return {...a,hash:sha(bytes),initial,initialIds,history,amendment,reconciliation};
}
export function verifyDailySpend(data,p){
 validateBudgetRows(data.requests);
 ensure(data.requests.length>=p.initial.requests.length&&p.initial.requests.every((r,i)=>canonical(r)===canonical(data.requests[i])),'BUDGET_POLICY','initial request history changed');
 if(data.dailyPolicySha256&&data.dailyPolicySha256!==p.hash)ensure(p.amendment&&data.dailyPolicySha256===p.amendment.hash&&canonical(data)===canonical(p.amendment.ledger),'BUDGET_POLICY','standing authorization changed without a bound immutable amendment');
 if(p.amendment)ensure(data.requests.length>=p.amendment.ledger.requests.length&&p.amendment.ledger.requests.every((r,i)=>canonical(r)===canonical(data.requests[i])),'BUDGET_POLICY','pre-correction requests cannot change');
 if(p.reconciliation){const all=new Map([...p.history.values()].map(x=>[x.row.id,x.row]));for(const r of data.requests)all.set(r.id,r);
  for(const {row} of p.reconciliation.known.values())ensure(all.has(row.id)&&canonical(all.get(row.id))===canonical(row),'BUDGET_RECONCILIATION','reconciled raw row changed');
  for(const row of p.reconciliation.excluded.values())ensure(p.history.has(row.id)&&all.has(row.id)&&canonical(all.get(row.id))===canonical(row),'BUDGET_RECONCILIATION','excluded historical settlement changed');
 }
 for(const r of data.requests){ensure(!p.history.has(r.id),'BUDGET_POLICY','historical request cannot be reintroduced');if(!p.initialIds.has(r.id))ensure(/^\d{4}-\d{2}-\d{2}$/.test(r.budgetDay??'')&&r.budgetDay>=p.initial.dayKey&&r.budgetDay<=data.dayKey,'BUDGET_POLICY','new requests need an explicit accounting day');}
}
export function dailySpendUsage(data,p,day){
 let actual=0,reserved=0,historicalReserved=0;
 const add=(r,d,historical)=>{if(r.status==='released')return;if(unknown(r)){reserved+=r.reserveMicros;if(historical)historicalReserved+=r.reserveMicros;}else if(d===day){
  if(p.reconciliation?.day===day&&p.reconciliation.excluded.has(r.id))return;
  const reconciled=p.reconciliation?.day===day?p.reconciliation.known.get(r.id):null;
  actual+=reconciled?reconciled.charge:(tokenCharge(r.usage,r.billingRates)??r.actualMicros);
 }};
 for(const {row,day:d} of p.history.values())add(row,d,true);
 for(const r of data.requests)add(r,r.budgetDay??p.initial.dayKey,false);
 return {actual,reserved,historicalReserved,held:actual+reserved};
}
