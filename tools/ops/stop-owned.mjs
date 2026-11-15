import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inspectProcess,processMatches} from './owned-process.mjs';
import {ensure} from '../../src/contracts.mjs';

export function archiveDeadInstance(state,{inspect=inspectProcess}={}){
  state=resolve(state);const files=['brain.launch.lock','brain-service.pid','brain.instance.json'].map(n=>join(state,n)).filter(existsSync);
  for(const file of files){let pid;try{pid=file.endsWith('.pid')?Number(readFileSync(file,'utf8')):JSON.parse(readFileSync(file,'utf8')).pid;}catch{ensure(false,'INSTANCE_EVIDENCE_INVALID','cannot establish ownership of stale evidence');}
    ensure(Number.isSafeInteger(pid)&&pid>0,'INSTANCE_EVIDENCE_INVALID','pid missing');ensure(!inspect(pid),'INSTANCE_RUNNING','recorded pid exists; never archive its ownership automatically');}
  if(!files.length)return {archived:0};const dir=join(state,'recovery',Date.now()+'-'+randomUUID());mkdirSync(dir,{recursive:true});
  for(const file of files)renameSync(file,join(dir,file.slice(state.length+1)));
  return {archived:files.length,evidenceDirectory:dir};
}
export async function stopOwned(record,{force=false,inspect=inspectProcess,kill=(pid)=>process.kill(pid),waitMs=30000,request=fetch}={}){
  const current=inspect(record.pid);if(!current)return {status:'already-exited'};
  ensure(processMatches(record,current),'PROCESS_IDENTITY_CHANGED','pid is insufficient; process identity differs');
  let gracefulError=null;
  try{
    if(record.component==='brain'){
      const instance=JSON.parse(readFileSync(join(record.stateDirectory,'brain.instance.json'),'utf8'));
      ensure(instance.pid===record.pid&&instance.shutdownToken,'INSTANCE_OWNERSHIP','ready instance control required');
      const result=await request(instance.url+'/v1/admin/shutdown',{method:'POST',signal:AbortSignal.timeout(Math.max(1,Math.min(waitMs,5000))),headers:{'x-jingyang-control':instance.shutdownToken,...(process.env.BRAIN_TOKEN?{'x-brain-token':process.env.BRAIN_TOKEN}:{})}});
      ensure(result.ok,'SHUTDOWN_REFUSED','brain refused graceful stop');
    }else if(record.controlFile&&record.controlToken){writeFileSync(record.controlFile,JSON.stringify({pid:record.pid,token:record.controlToken,command:'stop'}));}
    else ensure(false,'GRACEFUL_STOP_UNAVAILABLE','no graceful control; explicit force required');
  }catch(error){if(!force)throw error;gracefulError=error.code??error.name??'GRACEFUL_STOP_FAILED';}
  const deadline=Date.now()+waitMs;
  while(Date.now()<deadline){const p=inspect(record.pid);if(!p)return {status:'stopped'};if(p.createdAt&&p.createdAt!==record.createdAt)return {status:'stopped',replacementPresent:true};if(!p.createdAt||!p.executable||!p.commandLine){await new Promise(r=>setTimeout(r,200));continue;}ensure(processMatches(record,p),'PROCESS_IDENTITY_CHANGED','process changed while waiting');await new Promise(r=>setTimeout(r,200));}
  ensure(force,'SHUTDOWN_BUSY','process still working; ownership and evidence retained');
  ensure(processMatches(record,inspect(record.pid)),'PROCESS_IDENTITY_CHANGED','verify again before force stop');kill(record.pid);return {status:'force-requested',recoveryRequired:true,...(gracefulError?{gracefulError}:{})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},root=resolve(value('--root')??'.');
  if(args.includes('--archive-dead'))console.log(JSON.stringify(archiveDeadInstance(resolve(args[args.indexOf('--state')+1]))));
  else{const results=[];for(const component of ['connector','brain','ui','snowluma']){
    const file=join(root,'_local/ops',component+'.process.json');if(!existsSync(file)){results.push({component,status:'unverified-or-not-started'});continue;}
    try{results.push({component,...await stopOwned(JSON.parse(readFileSync(file,'utf8')),{force:args.includes('--force')})});}catch(error){results.push({component,status:'preserved',error:error.code??'STOP_FAILED'});process.exitCode=1;}
  }console.log(JSON.stringify(results,null,2));}
}
