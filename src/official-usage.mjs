import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

// Read-only importer for DeepSeek Platform CSV exports.
// This is an account-level bill, not a per-request proof. It must never be
// used to rewrite a request's usage or to silently release an unknown reserve.
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const KEY_LABEL='Threadline Agent';

function csvLine(line){
  const cells=[];let cell='',quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;continue;}
    if(c===','&&!quoted){cells.push(cell);cell='';continue;}
    cell+=c;
  }
  cells.push(cell);return cells;
}

function parseCsv(text){
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
  if(!lines.length)return [];
  const headers=lines.shift().split(',').map(x=>x.trim());
  return lines.map(line=>Object.fromEntries(headers.map((h,i)=>[h,csvLine(line)[i]??''])));
}

function dateOf(value){
  const m=/^(\d{4}-\d{2}-\d{2})T/.exec(String(value??''));
  return m?.[1]??null;
}

export function loadOfficialUsage({directory,day=null,keyLabel=KEY_LABEL}={}){
  if(typeof directory!=='string'||!directory)throw Object.assign(new Error('official usage directory required'),{code:'OFFICIAL_USAGE_CONFIG'});
  if(day!==null&&!DAY.test(day))throw Object.assign(new Error('official usage day must be YYYY-MM-DD'),{code:'OFFICIAL_USAGE_DAY'});
  let files;
  try{files=readdirSync(directory).filter(f=>/^cost-.*\.csv$/i.test(f));}catch(error){throw Object.assign(new Error('official usage directory unreadable'),{code:'OFFICIAL_USAGE_UNAVAILABLE',cause:error});}
  const rows=[];
  const amountRows=[];
  for(const file of files){
    const parsed=parseCsv(readFileSync(join(directory,file),'utf8'));
    for(const row of parsed){
      const d=dateOf(row.start_time_iso??row.start_time??'');
      if(!d||(day&&d!==day))continue;
      const cost=Number(row.cost);
      if(!Number.isFinite(cost))continue;
      rows.push({file,day:d,model:row.model??row.name??'',walletType:row.wallet_type??'',currency:row.currency??'',cost,raw:row});
    }
  }
  // The cost export has no API-key column. If an amount export is present,
  // require the configured key label to be present; otherwise retain rows but
  // mark key attribution unverified.
  let keyAttribution='not-present';
  try{
    const amountFiles=readdirSync(directory).filter(f=>/^amount-.*\.csv$/i.test(f));
    const labels=new Set();
    for(const file of amountFiles)for(const row of parseCsv(readFileSync(join(directory,file),'utf8'))){
      const d=dateOf(row.start_time_iso??row.start_time??'');
      if(!d||(day&&d!==day))continue;
      if(row.api_key_name)labels.add(row.api_key_name);
    }
    if(labels.size){keyAttribution=labels.has(keyLabel)?'matched':'mismatch';}
  }catch{}
  const spendMicros=Math.round(rows.reduce((sum,r)=>sum+r.cost,0)*1e6);
  return {
    format:'jingyang-official-usage-v1',
    day:day??null,
    keyLabel,
    keyAttribution,
    known:rows.length>0,
    requestCount:null,
    spendMicros,
    currency:rows.find(r=>r.currency)?.currency??'CNY',
    sourceFiles:files,
    rows,
  };
}

export function officialUsageGate({directory,day,limitMicros=5_000_000,keyLabel=KEY_LABEL}={}){
  const usage=loadOfficialUsage({directory,day,keyLabel});
  if(!usage.known)return {known:false,allow:false,reason:'OFFICIAL_USAGE_UNKNOWN',usage};
  if(usage.keyAttribution==='mismatch')return {known:true,allow:false,reason:'OFFICIAL_KEY_MISMATCH',usage};
  return {known:true,allow:usage.spendMicros<limitMicros,reason:usage.spendMicros<limitMicros?'BELOW_LIMIT':'LIMIT_REACHED',usage};
}
