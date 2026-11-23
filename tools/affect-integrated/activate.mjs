import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const root=process.cwd(),dir=resolve(process.argv[2]??'');
if(!dir.startsWith(resolve(root,'_local/affect-install')+'\\'))throw Error('INSTALL_DIRECTORY_REQUIRED');
const file=join(dir,'pending-active.json'),active=join(root,'_local/ops/affect-active.json');
if(existsSync(active))throw Error('ALREADY_ACTIVE');
const report=JSON.parse(readFileSync(file)),sha=x=>createHash('sha256').update(x).digest('hex');
if(report.format!=='jingyang-affect-install-v1'||!report.migration.historyPreserved)throw Error('INSTALL_NOT_VERIFIED');
if(sha(readFileSync(report.rollbackStorePath))!==report.migration.sourceSha256)throw Error('OLD_STORE_CHANGED');
const db=new DatabaseSync(report.storePath,{readOnly:true});
try{
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('DATABASE_INTEGRITY');
 report.activationHistoryHash=sha(JSON.stringify(db.prepare('SELECT id,revision,body FROM versions ORDER BY id,revision').all()));
 report.activationVersions=db.prepare('SELECT count(*) n FROM versions').get().n;
}finally{db.close();}
report.installedHashes={};for(const f of Object.keys(report.originalHashes))report.installedHashes[f]=sha(readFileSync(join(root,f)));
report.activatedAt=new Date().toISOString();report.liveRunning=false;report.liveBlocker='Existing live ledger contains one cost-unknown request; no bypass or paid restart authorized by this installation.';
writeFileSync(join(dir,'ACTIVATED.json'),JSON.stringify(report,null,2));
writeFileSync(active+'.new',JSON.stringify(report,null,2));renameSync(active+'.new',active);
console.log(JSON.stringify({activated:true,liveRunning:false,historyVersions:report.activationVersions,realModelCalls:0}));
