import {readFileSync,existsSync} from 'node:fs';import {writeLedgerAtomically} from './ledger-io.mjs';
export const officialDay=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
export function officialDashboard({file,token,clock=Date.now}={}){
 if(typeof token!=='string'||token.length<32)throw Error('OFFICIAL_REPORT_TOKEN_CONFIG');
 let current=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
 const valid=(r,now)=>r?.source==='https://platform.deepseek.com/usage'&&r.keyLabel==='新版鲸漾系统'&&r.period==='today'&&r.timeZone==='Asia/Shanghai'&&r.currency==='CNY'&&r.day===officialDay(now)&&Number.isSafeInteger(r.spendMicros)&&r.spendMicros>=0&&Number.isSafeInteger(r.requestCount)&&r.requestCount>=0&&Number.isSafeInteger(r.capturedAt)&&r.capturedAt<=now+5000&&now-r.capturedAt<=90000;
 return {accept(report,secret){if(secret!==token)throw Object.assign(Error('report token required'),{code:'UNAUTHORIZED'});if(!valid(report,clock()))throw Object.assign(Error('complete current-day Key-filtered official page required'),{code:'OFFICIAL_USAGE_INVALID'});if(current?.day===report.day&&report.capturedAt<current.capturedAt)throw Error('OFFICIAL_USAGE_OLD_REPORT');writeLedgerAtomically(file,report);current=report;return {ok:true};},gate(){const known=valid(current,clock());return {known,allow:known&&current.spendMicros<5000000,reason:!known?'OFFICIAL_USAGE_UNAVAILABLE':current.spendMicros>=5000000?'OFFICIAL_LIMIT_REACHED':'BELOW_OFFICIAL_LIMIT',usage:current,platformDelayAcceptedMs:300000};}};
}
