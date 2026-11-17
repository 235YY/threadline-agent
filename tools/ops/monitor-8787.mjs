// Append-only health monitor for the isolated 8787 live run.
import {appendFileSync, existsSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const dir=resolve('_local/acceptance');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const log=resolve(dir,`8787-monitor-${stamp}.jsonl`);
mkdirSync(dir,{recursive:true});
const end=Date.now()+2*60*60*1000;
const once=async()=>{
  const row={at:new Date().toISOString(),ok:null,error:null};
  try{const r=await fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(5000)});row.status=r.status;row.ok=r.ok;row.body=await r.json();}
  catch(error){row.error=error.code??error.message;}
  appendFileSync(log,JSON.stringify(row)+'\n');
};
while(Date.now()<end){await once();await new Promise(r=>setTimeout(r,60*1000));}
appendFileSync(log,JSON.stringify({at:new Date().toISOString(),monitor:'complete'})+'\n');
