import {readFileSync,copyFileSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
if(process.argv[2]!=='--apply')throw Error('Explicit --apply required; read installation report first');
const root=process.cwd(),pointer=join(root,'_local/ops/affect-active.json'),p=JSON.parse(readFileSync(pointer));
const backup=resolve(p.backupDirectory),store=resolve(p.storePath);
if(!backup.startsWith(resolve(root,'_local/affect-install')+'\\')||!store.startsWith(backup+'\\'))throw Error('UNEXPECTED_PATH');
for(const file of ['_local/brain/state/brain-service.pid','_local/ops/brain.pid','_local/ops/connector.pid']){
 let pid;try{pid=Number(readFileSync(join(root,file),'utf8'));}catch{continue;}
 if(Number.isSafeInteger(pid)&&pid>0){let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}if(alive)throw Error('STOP_SERVICES_BEFORE_ROLLBACK');}
}
const sha=x=>createHash('sha256').update(x).digest('hex'),db=new DatabaseSync(store,{readOnly:true});let current;
try{current=sha(JSON.stringify(db.prepare('SELECT id,revision,body FROM versions ORDER BY id,revision').all()));}finally{db.close();}
if(current!==p.activationHistoryHash)throw Error('NEW_HISTORY_EXISTS: review and preserve subsequent experiences before rollback');
for(const [f,h] of Object.entries(p.installedHashes))if(sha(readFileSync(join(root,f)))!==h)throw Error('SOURCE_CHANGED:'+f);
for(const [f,h] of Object.entries(p.originalHashes))if(sha(readFileSync(join(backup,'files',f)))!==h)throw Error('BACKUP_CHANGED:'+f);
for(const f of Object.keys(p.originalHashes))copyFileSync(join(backup,'files',f),join(root,f));
renameSync(pointer,join(backup,'deactivated-pointer.json'));
console.log(JSON.stringify({rolledBack:true,storePath:p.rollbackStorePath,affectStorePreserved:true,noServicesStarted:true}));
