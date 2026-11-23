// A-owned IR-02 bootstrap-side policy tests. Synthetic core only: no server route,
// no store writes, no model, no QQ, no production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchBrain,inboundScenePolicy} from '../tools/brain-service/bootstrap.mjs';

const tempRoot=t=>{const dir=mkdtempSync(join(tmpdir(),'jy-inbound-policy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
function fakeCore(captured){
 return {READ_ONLY_HOST_TOOLS:[],async startBrainService(options){
  captured.options=options;
  return {server:{listening:false},port:0,url:'http://offline',store:{recordDiagnostic:()=>({logged:true}),read:()=>null,all:()=>[]},
   health:()=>({cognitionBusy:false,active:null,pending:[]}),close(){},stopScheduling(){},beginShutdown(){},startScheduling(){},runCognitionExclusive:async fn=>fn()};
 }};
}
function baseEnv(root){return {BRAIN_STORE:join(root,'subject.sqlite'),BRAIN_STATE:join(root,'state'),BRAIN_STYLE_DIR:join(root,'style'),JY_AFFECT:'0'};}
async function boot(t,extra={}){
 const state=tempRoot(t),captured={};
 const running=await launchBrain({root:process.cwd(),env:{...baseEnv(state),...extra},dependencies:{core:fakeCore(captured)}});
 t.after(async()=>{try{await running.stop();}catch{}});
 return captured;
}

test('inboundScenePolicy derives mode/owner/whitelist/group-ingest/token/allowAllPrivate from existing env only',()=>{
 assert.deepEqual(inboundScenePolicy({env:{
  QQ_OWNER:' 10001 ',QQ_TEST_ONLY_OWNER:'99999',QQ_ALLOWED_GROUPS:'20002, 20003,not-a-group,20002,',
  JY_GROUP_INGEST:'off',JY_REQUIRE_BRAIN_TOKEN:'1'}}),
  {mode:'enforce',ownerQQ:'10001',allowedGroups:['20002','20003'],groupIngest:'off',requireToken:true,allowAllPrivate:false});
 assert.deepEqual(inboundScenePolicy({env:{QQ_TEST_ONLY_OWNER:'500',QQ_ALLOWED_GROUPS:'',JY_GROUP_INGEST:'on'}}),
  {mode:'enforce',ownerQQ:'500',allowedGroups:[],groupIngest:'on',requireToken:false,allowAllPrivate:false});
 assert.deepEqual(inboundScenePolicy({env:{QQ_OWNER:'not-qq',QQ_ALLOWED_GROUPS:'x, 7'}}),
  {mode:'enforce',ownerQQ:null,allowedGroups:['7'],groupIngest:'on',requireToken:false,allowAllPrivate:false});
 assert.deepEqual(inboundScenePolicy({env:{}}),{mode:'enforce',ownerQQ:null,allowedGroups:[],groupIngest:'on',requireToken:false,allowAllPrivate:false});
 // M5: allowAllPrivate is derived from the connector existing QQ_CHAT_SCOPE key.
 assert.deepEqual(inboundScenePolicy({env:{QQ_OWNER:'10001',QQ_CHAT_SCOPE:'all'}}),
  {mode:'enforce',ownerQQ:'10001',allowedGroups:[],groupIngest:'on',requireToken:false,allowAllPrivate:true});
 assert.equal(inboundScenePolicy({env:{QQ_CHAT_SCOPE:'owner-test'}}).allowAllPrivate,false);
});

test('launchBrain passes the same inboundScenePolicy to the Lead-owned service seam',async t=>{
 const token='t'.repeat(24),captured=await boot(t,{QQ_OWNER:'10001',QQ_ALLOWED_GROUPS:'20002,20003',QQ_CHAT_SCOPE:'all',JY_GROUP_INGEST:'off',BRAIN_TOKEN:token,JY_REQUIRE_BRAIN_TOKEN:'1'});
 assert.deepEqual(captured.options.inboundScenePolicy,{mode:'enforce',ownerQQ:'10001',allowedGroups:['20002','20003'],groupIngest:'off',requireToken:true,allowAllPrivate:true});
 assert.equal(captured.options.token,token);
});

test('requireToken=true without BRAIN_TOKEN refuses startup before the service seam',async t=>{
 const state=tempRoot(t),captured={};
 await assert.rejects(()=>launchBrain({root:process.cwd(),env:{...baseEnv(state),JY_REQUIRE_BRAIN_TOKEN:'1'},dependencies:{core:fakeCore(captured)}}),{code:'BRAIN_TOKEN_REQUIRED'});
 assert.equal(captured.options??null,null);
});
