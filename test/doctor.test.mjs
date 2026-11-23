import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {diagnose,formatReport} from '../tools/brain-service/doctor.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=t=>{const d=mkdtempSync(join(tmpdir(),'jy-doctor-'));return d;};
const cleanRoot=t=>{const d=scratch(t);mkdirSync(join(d,'src'),{recursive:true});writeFileSync(join(d,'package.json'),'{}');writeFileSync(join(d,'src','store.mjs'),'');return d;};
const find=(r,area)=>r.checks.find(c=>c.area===area);
const base={root,nodeVersion:'26.8.0',probePort:false};

test('dry-run on a clean checkout is ready and says the store would be new',async t=>{
 const r=await diagnose({...base,root:cleanRoot(t),env:{}});
 assert.equal(r.mode,'dry-run');assert.equal(r.ready,true,formatReport(r));
 assert.equal(find(r,'identity').status,'warn');assert.match(find(r,'store').summary,/新建一个空主体/);
});
test('old Node and invalid flags are blocking, with an actionable fix',async()=>{
 const r=await diagnose({...base,nodeVersion:'22.1.0',env:{JY_TASK_THREADS:'yes'}});
 assert.equal(r.ready,false);assert.equal(find(r,'node').status,'blocked');assert.equal(find(r,'config').status,'blocked');assert.ok(find(r,'config').fix);
});
test('live lists every missing operator resource instead of assuming empty defaults; never creates files',async t=>{
 const d=scratch(t),before=readdirSync(d);
 const env={BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_LEDGER:join(d,'journal.json'),BRAIN_STORE:join(d,'s.sqlite'),BRAIN_STATE:join(d,'state'),BRAIN_IDENTITY_FILE:join(d,'none.txt'),JY_OPEN_LIFE:'1'};
 const r=await diagnose({...base,env,platform:'linux'});
 assert.equal(r.ready,false);
 for(const [area,status] of [['identity','blocked'],['store','blocked'],['request-journal','blocked'],['qq-scope','blocked'],['official-usage','blocked'],['model-credential','blocked'],['open-life','blocked'],['http-auth','warn']])
  assert.equal(find(r,area)?.status,status,area);
 assert.deepEqual(readdirSync(d),before);
});
test('existing journal of the wrong format and an existing launch lock are blocking',async t=>{
 const d=scratch(t);mkdirSync(join(d,'state'));writeFileSync(join(d,'state','brain.launch.lock'),'{}');writeFileSync(join(d,'id.txt'),'你是一个合成测试主体。');
 writeFileSync(join(d,'journal.json'),JSON.stringify({format:'jingyang-daily-budget-v1'}));
 const r=await diagnose({...base,platform:'win32',env:{BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_LEDGER:join(d,'journal.json'),BRAIN_STORE:join(d,'s.sqlite'),BRAIN_STATE:join(d,'state'),BRAIN_IDENTITY_FILE:join(d,'id.txt'),JY_OFFICIAL_USAGE_TOKEN:'x'.repeat(32)}});
 assert.equal(find(r,'identity').status,'ok');assert.equal(find(r,'request-journal').status,'blocked');assert.equal(find(r,'instance').status,'blocked');assert.equal(find(r,'official-usage').status,'ok');
});
test('affect readiness uses packaged runtime/provenance, warns on degradation, blocks only when required',async t=>{
 // The repo root carries the verified packaged runtime: JY_AFFECT=1 alone is OK.
 const packaged=await diagnose({...base,env:{JY_AFFECT:'1'},spawn:()=>({status:1,stdout:''})});
 assert.equal(find(packaged,'affect').status,'ok');assert.match(find(packaged,'affect').summary,/打包 runtime/);
 // A clean checkout without the runtime degrades (WARN, still ready), not a block.
 const clean=cleanRoot(t);
 const missing=await diagnose({...base,root:clean,env:{JY_AFFECT:'1'},spawn:()=>({status:0,stdout:'3.13.2\n'})});
 assert.equal(find(missing,'affect').status,'warn');assert.match(find(missing,'affect').summary,/降级/);assert.equal(missing.ready,true);
 // Explicit operator requirement turns the same condition into a block.
 const required=await diagnose({...base,root:clean,env:{JY_AFFECT:'1',JY_AFFECT_REQUIRED:'1'},spawn:()=>({status:0,stdout:'3.13.2\n'})});
 assert.equal(find(required,'affect').status,'blocked');assert.equal(required.ready,false);
 // Operator-provided interpreter: too old/unavailable warns by default, blocks when required.
 const old=await diagnose({...base,root:clean,env:{JY_AFFECT:'1',JY_AFFECT_PYTHON:'python3'},spawn:()=>({status:0,stdout:'3.9.1\n'})});
 assert.equal(find(old,'affect').status,'warn');
 const oldRequired=await diagnose({...base,root:clean,env:{JY_AFFECT:'1',JY_AFFECT_PYTHON:'python3',JY_AFFECT_REQUIRED:'1'},spawn:()=>({status:0,stdout:'3.9.1\n'})});
 assert.equal(find(oldRequired,'affect').status,'blocked');
 const good=await diagnose({...base,root:clean,env:{JY_AFFECT:'1',JY_AFFECT_PYTHON:'python3'},spawn:()=>({status:0,stdout:'3.13.2\n'})});
 assert.equal(find(good,'affect').status,'ok');
 // QQ bridge requirements are still explicit when bridge checks are requested.
 const r=await diagnose({...base,env:{JY_AFFECT:'1',QQ_UIN:'123'},qq:true,spawn:()=>({status:0,stdout:'3.13.2\n'})});
 assert.equal(find(r,'qq-sdk').status,'blocked');assert.equal(find(r,'qq-onebot').status,'blocked');
});
test('live: new subject, new journal and all-chat scope are allowed only when explicitly acknowledged',async t=>{
 const rRoot=cleanRoot(t),d=scratch(t);writeFileSync(join(d,'id.txt'),'你是一个合成测试主体。');
 const env={BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_LEDGER:join(d,'journal.json'),BRAIN_STORE:join(d,'s.sqlite'),BRAIN_STATE:join(d,'state'),BRAIN_IDENTITY_FILE:join(d,'id.txt'),JY_OFFICIAL_USAGE_TOKEN:'x'.repeat(32),BRAIN_TOKEN:'t'};
 const blocked=await diagnose({...base,root:rRoot,platform:'win32',env});
 assert.deepEqual(blocked.checks.filter(c=>c.status==='blocked').map(c=>c.area).sort(),['model-credential','qq-scope','request-journal','store']);
 const ack=await diagnose({...base,root:rRoot,platform:'win32',env:{...env,JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1',JY_QQ_SCOPE:'all'}});
 for(const area of ['store','request-journal','qq-scope'])assert.equal(find(ack,area).status,'warn',area);
 const owner=await diagnose({...base,root:rRoot,platform:'win32',env:{...env,QQ_TEST_ONLY_OWNER:'10001'}});assert.equal(find(owner,'qq-scope').status,'ok');
});
