// Explicit installation into this project. No provider call or process launch.
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
if(process.argv[2]!=='--apply')throw Error('Explicit --apply required');
const candidate=join(root,'evaluation/affect-integrated_2026-11-11/candidate-v1');
const {verifyCandidate}=await import(new URL('../../evaluation/affect-integrated_2026-11-11/candidate-v1/tools/affect-integrated/verify.mjs',import.meta.url));verifyCandidate();
const protectedFiles=JSON.parse(readFileSync(join(root,'evaluation/affect-integrated_2026-11-11/report.json'))).protectedFiles;
for(const [f,h] of Object.entries(protectedFiles))if(hash(readFileSync(join(root,f)))!==h)throw Error('SOURCE_CHANGED:'+f);
const source=join(root,'_local/migrate/staging-20261107.sqlite'),config=join(root,'_local/ops/affect-active.json');
if(existsSync(config))throw Error('ALREADY_CONNECTED');
const stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const backup=join(root,'_local/affect-install',stamp);mkdirSync(backup,{recursive:true});
const replacements=['src/cognition.mjs','src/continuity-session.mjs','src/continuity.mjs','src/debug-reader.mjs','src/schema.mjs','src/store.mjs','src/turn-driver.mjs','tools/brain-service/server.mjs','test/workbench-materials.test.mjs'];
const extras=['src/affect-contract.mjs','prompts/decision-affect.zh.md','tools/affect-integrated/session.mjs','tools/affect-integrated/service.mjs','tools/affect-integrated/copy-upgrade.mjs'];
const backups=[...replacements,'tools/brain-service/run.mjs','tools/ops/start.ps1'];
const originalHashes={};for(const f of backups){const dest=join(backup,'files',f);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,f),dest);originalHashes[f]=hash(readFileSync(dest));}
const {copyUpgrade}=await import(new URL('../../evaluation/affect-integrated_2026-11-11/candidate-v1/tools/affect-integrated/copy-upgrade.mjs',import.meta.url));
const upgraded=join(backup,'active-subject.sqlite');const migration=await copyUpgrade(source,upgraded);
try{
 for(const f of [...replacements,...extras]){mkdirSync(dirname(join(root,f)),{recursive:true});copyFileSync(join(candidate,f),join(root,f));}
 const {ContinuityStore}=await import('../../src/store.mjs'),{AffectSession}=await import('./session.mjs');
 const store=new ContinuityStore(upgraded);try{await new AffectSession({store,subjectId:'jingyang'}).initialize();}finally{store.close();}
 const old=new DatabaseSync(source,{readOnly:true}),next=new DatabaseSync(upgraded,{readOnly:true});let preserved=0;
 try{for(const row of old.prepare('SELECT id,revision,body FROM versions').all()){if(next.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(row.id,row.revision)?.body!==row.body)throw Error('HISTORY_CHANGED');preserved++;}}finally{old.close();next.close();}
 if(hash(readFileSync(source))!==migration.sourceSha256)throw Error('ORIGINAL_DATABASE_CHANGED');
 const report={format:'jingyang-affect-install-v1',at:new Date().toISOString(),backupDirectory:backup,rollbackStorePath:source,storePath:upgraded,enabled:true,schema:11,subjectId:'jingyang',ledgerPath:join(root,'_local/brain/live-rc313/budget.json'),originalHashes,migration,preservedHistoricalVersions:preserved,realModelCalls:0,liveRunning:false};
 writeFileSync(join(backup,'INSTALL.json'),JSON.stringify(report,null,2));
 writeFileSync(join(backup,'pending-active.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({backup,prepared:true,preservedHistoricalVersions:preserved,sourceUnchanged:true}));
}catch(e){for(const f of replacements)copyFileSync(join(backup,'files',f),join(root,f));writeFileSync(join(backup,'FAILED.json'),JSON.stringify({error:e.message,restoredOriginalSources:true}));throw e;}
