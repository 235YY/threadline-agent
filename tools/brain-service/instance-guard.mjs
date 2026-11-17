import {existsSync,mkdirSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync,fsyncSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ensure} from '../../src/contracts.mjs';

const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export function claimBrainInstance({stateDirectory,pid=process.pid,isAlive=alive}){
 mkdirSync(stateDirectory,{recursive:true});
 const lock=join(stateDirectory,'brain.launch.lock'),pidFile=join(stateDirectory,'brain-service.pid'),instanceFile=join(stateDirectory,'brain.instance.json');
 for(const path of [pidFile,instanceFile])if(existsSync(path)){
  let priorPid;try{priorPid=path===pidFile?Number(readFileSync(path,'utf8').trim()):JSON.parse(readFileSync(path,'utf8')).pid;}catch{}
  ensure(!isAlive(priorPid),'INSTANCE_RUNNING','a recorded brain instance is still alive');
  ensure(false,'INSTANCE_RECOVERY_REQUIRED','stale instance evidence must be reviewed and explicitly archived');
 }
 let fd;try{fd=openSync(lock,'wx');}catch{ensure(false,'INSTANCE_LOCKED','launch lock exists; do not guess ownership or delete it');}
 const instanceId=randomUUID();let published=false,pidOwned=false,instanceOwned=false,closed=false;
 try{writeFileSync(fd,JSON.stringify({instanceId,pid,startedAt:new Date().toISOString()})+'\n');fsyncSync(fd);}catch(e){closeSync(fd);throw e;}
 const ownsLock=()=>{try{return JSON.parse(readFileSync(lock,'utf8')).instanceId===instanceId;}catch{return false;}};
 return {instanceId,pidFile,instanceFile,lock,
  publish(value){
   ensure(!published&&!closed&&ownsLock(),'INSTANCE_OWNERSHIP','instance no longer owns its startup lease');
   let file;
   try{file=openSync(pidFile,'wx');pidOwned=true;writeFileSync(file,String(pid));fsyncSync(file);}finally{if(file!==undefined)closeSync(file);}
   file=undefined;
   try{file=openSync(instanceFile,'wx');instanceOwned=true;writeFileSync(file,JSON.stringify({...value,instanceId,pid},null,2)+'\n');fsyncSync(file);}finally{if(file!==undefined)closeSync(file);}
   published=true;return {...value,instanceId,pid};
  },
  close(){
   if(closed)return;closed=true;closeSync(fd);
   if(!ownsLock())return;
   if(pidOwned&&existsSync(pidFile)&&readFileSync(pidFile,'utf8').trim()===String(pid))unlinkSync(pidFile);
   if(instanceOwned&&existsSync(instanceFile)){let own=false;try{own=JSON.parse(readFileSync(instanceFile,'utf8')).instanceId===instanceId;}catch{}if(own)unlinkSync(instanceFile);}
   unlinkSync(lock);
  }
 };
}

// A stated, bounded startup inventory, not a claim that all lazy-loaded code is measured.
export function runtimeSourceIdentity(root){
 const directories=['src','prompts','tools/brain-service','tools/affect-integrated','tools/affect-shadow','tools/qq-connect','tools/ops','tools/native-capabilities','tools/open-life'];
 const files=[];
 function visit(dir){if(!existsSync(dir))return;for(const e of readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink()||e.name==='additions'||e.name==='upstream-tests'||e.name==='__pycache__')continue;const p=join(dir,e.name);if(e.isDirectory())visit(p);else if(/\.(mjs|py|md|json|ps1)$/.test(e.name)&&!e.name.endsWith('.test.mjs'))files.push(p);}}
 for(const d of directories)visit(join(root,d));
 for(const name of ['scripts/study-key.ps1'])if(existsSync(join(root,name)))files.push(join(root,name));
 const rows=[...new Set(files)].sort().map(path=>({path:relative(root,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
 return {fingerprint:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),files:rows.length,scope:directories,meaning:'startup disk inventory; verify unchanged before publishing ready'};
}
