import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {ContinuityStore} from '../../src/store.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function history(db){return {rows:db.prepare('SELECT count(*) AS n FROM versions').get().n,hash:sha(JSON.stringify(db.prepare('SELECT id,revision,body FROM versions ORDER BY id,revision').all()))};}
export async function copyUpgrade(source,destination){
 source=resolve(source);destination=resolve(destination);
 if(source===destination||existsSync(destination))throw Error('UPGRADE_NEW_COPY_REQUIRED');
 const before=sha(readFileSync(source)),db=new DatabaseSync(source,{readOnly:true});let old;
 try{if(db.prepare('PRAGMA user_version').get().user_version!==10)throw Error('UPGRADE_SCHEMA_10_REQUIRED');old=history(db);mkdirSync(dirname(destination),{recursive:true});await backup(db,destination);}finally{db.close();}
 const upgraded=new ContinuityStore(destination,{migrateV10:true});upgraded.close();
 const copy=new DatabaseSync(destination,{readOnly:true});let report;
 try{const after=history(copy);report={sourceUnchanged:before===sha(readFileSync(source)),sourceSha256:before,from:10,to:copy.prepare('PRAGMA user_version').get().user_version,historyBefore:old,historyAfter:after,historyPreserved:old.hash===after.hash,integrity:copy.prepare('PRAGMA integrity_check').get().integrity_check};}finally{copy.close();}
 if(!report.sourceUnchanged||!report.historyPreserved||report.to!==11||report.integrity!=='ok')throw Error('UPGRADE_VERIFICATION_FAILED');
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,destination]=process.argv.slice(2);if(!source||!destination)throw Error('Usage: node copy-upgrade.mjs SOURCE NEW_COPY');
 const report=await copyUpgrade(source,destination);writeFileSync(destination+'.upgrade.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
