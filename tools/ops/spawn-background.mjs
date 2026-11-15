import {inspectProcess} from './owned-process.mjs';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
// Preserve the caller's user/session context. Shell-based Start-Process changed
// QQ discovery visibility on this host. No impersonation or privilege changes.
import {spawn} from 'node:child_process';
import {openSync,closeSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const [directory,outFile,errFile,...args]=process.argv.slice(2);
if(!directory||!outFile||!errFile||!args.length)throw Error('cwd stdout stderr and node arguments required');
for(const f of [outFile,errFile])mkdirSync(dirname(resolve(f)),{recursive:true});
const stdout=openSync(outFile,'a'),stderr=openSync(errFile,'a');
try{
 args[0]=resolve(directory,args[0]);
 const component=basename(outFile).split('.')[0],recordPath=join(dirname(resolve(outFile)),component+'.process.json');
 const controlFile=recordPath+'.stop.json',controlToken=randomUUID();
 const controlled=['connector','ui'].includes(component);
 const child=spawn(process.execPath,args,{cwd:resolve(directory),env:{...process.env,...(controlled?{JY_CONTROL_FILE:controlFile,JY_CONTROL_TOKEN:controlToken}:{})},windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
 await new Promise((res,rej)=>{child.once('spawn',res);child.once('error',rej);});child.unref();
 try{
 const identity=inspectProcess(child.pid);if(!identity?.createdAt){child.kill();throw Error('cannot verify spawned process identity');}
 writeFileSync(recordPath,JSON.stringify({format:'jingyang-owned-process-v1',component,pid:child.pid,entry:args[0],executable:identity.executable,createdAt:identity.createdAt,stateDirectory:process.env.BRAIN_STATE??null,...(controlled?{controlFile,controlToken}:{})},null,2));
 }catch(error){child.kill();throw error;}
 console.log(JSON.stringify({Id:child.pid,method:'node-spawn',windowsHide:true}));
}finally{closeSync(stdout);closeSync(stderr);}
