import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {affectRuntimeConfig} from './runtime-config.mjs';
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'affect-live-config-'));mkdirSync(join(root,'_local/ops'),{recursive:true});return root;};
const active={format:'jingyang-affect-install-v1',enabled:true,schema:11,storePath:'explicit-upgraded.sqlite',rollbackStorePath:'original.sqlite'};
test('no pointer preserves original default and does not enable affect',()=>{const root=fixture(),r=affectRuntimeConfig({root,env:{}});assert.equal(r.enabled,false);assert.equal(r.storePath,resolve(root,'_local/brain/subject.sqlite'));});
test('active pointer selects upgraded store and integrated session',()=>{const root=fixture();writeFileSync(join(root,'_local/ops/affect-active.json'),JSON.stringify(active));const r=affectRuntimeConfig({root,env:{}});assert.equal(r.enabled,true);assert.equal(r.storePath,resolve(root,active.storePath));});
test('explicit isolated store override remains available',()=>{const root=fixture();writeFileSync(join(root,'_local/ops/affect-active.json'),JSON.stringify(active));const r=affectRuntimeConfig({root,env:{BRAIN_STORE:'isolated.sqlite'}});assert.equal(r.storePath,resolve(root,'isolated.sqlite'));assert.equal(r.enabled,true);});
test('disabling affect without rollback store is rejected',()=>{const root=fixture();writeFileSync(join(root,'_local/ops/affect-active.json'),JSON.stringify(active));assert.throws(()=>affectRuntimeConfig({root,env:{JY_AFFECT:'0'}}),{code:'AFFECT_ACTIVE_CONFIG'});});
test('invalid pointer does not silently fall back to old database',()=>{const root=fixture();writeFileSync(join(root,'_local/ops/affect-active.json'),JSON.stringify({...active,schema:10}));assert.throws(()=>affectRuntimeConfig({root,env:{}}),{code:'AFFECT_ACTIVE_CONFIG'});});
test('real launcher starts affect mode without model or QQ and opens the chosen upgraded store',async()=>{
 const root=process.cwd(),dir=fixture(),pending=JSON.parse(readFileSync(join(root,'_local/affect-install/2026-11-11T14-49-29-810Z/pending-active.json')));
 const child=spawn(process.execPath,['tools/brain-service/run.mjs'],{cwd:root,windowsHide:true,env:{...process.env,BRAIN_LIVE:'0',BRAIN_HEARTBEAT_MS:'0',BRAIN_PORT:'0',BRAIN_GLOBAL:'1',JY_AFFECT:'1',BRAIN_STORE:pending.storePath,BRAIN_STATE:join(dir,'state'),BRAIN_STYLE_DIR:join(dir,'style')},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);let timer;
 try{const info=await new Promise((res,rej)=>{let out='';timer=setTimeout(()=>rej(Error('launcher timeout:'+stderr)),15000);child.on('error',rej);child.on('exit',code=>rej(Error('launcher exit '+code+':'+stderr)));child.stdout.on('data',b=>{out+=b;const line=out.split('\n').find(l=>l.startsWith('{'));if(line){try{res(JSON.parse(line));}catch{}}});});clearTimeout(timer);assert.equal(info.mode,'dry-run');assert.equal(info.affect,true);assert.equal(info.storePath,pending.storePath);assert.equal(info.heartbeatMs,0);assert.equal(info.maintenance,false);const health=await (await fetch(info.url+'/health')).json();assert.equal(health.ok,true);assert.equal(health.motivationState.id,'motivation:jingyang');}
 finally{clearTimeout(timer);child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);});}
});
test('rollback refuses new history and restores untouched installation only',()=>{
 const root=fixture(),dir=join(root,'_local/affect-install/test');mkdirSync(join(dir,'files'),{recursive:true});
 writeFileSync(join(root,'source.mjs'),'new');writeFileSync(join(dir,'files/source.mjs'),'old');
 const sha=x=>createHash('sha256').update(x).digest('hex'),db=new DatabaseSync(join(dir,'active.sqlite'));
 db.exec('CREATE TABLE versions(id TEXT,revision INTEGER,body TEXT)');
 const pointer=join(root,'_local/ops/affect-active.json'),p={backupDirectory:dir,storePath:join(dir,'active.sqlite'),rollbackStorePath:join(root,'old.sqlite'),activationHistoryHash:sha('[]'),installedHashes:{'source.mjs':sha('new')},originalHashes:{'source.mjs':sha('old')}};
 writeFileSync(pointer,JSON.stringify(p));db.prepare('INSERT INTO versions VALUES(?,?,?)').run('new-history',1,'{}');
 const script=resolve('tools/affect-integrated/rollback.mjs');let r=spawnSync(process.execPath,[script,'--apply'],{cwd:root,encoding:'utf8'});
 assert.notEqual(r.status,0);assert.match(r.stderr,/NEW_HISTORY_EXISTS/);assert.equal(readFileSync(join(root,'source.mjs'),'utf8'),'new');
 db.exec('DELETE FROM versions');db.close();r=spawnSync(process.execPath,[script,'--apply'],{cwd:root,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(root,'source.mjs'),'utf8'),'old');assert.equal(existsSync(pointer),false);
});
