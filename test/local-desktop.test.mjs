
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDesktop,DesktopJournal} from '../scripts/local-desktop.mjs';
import {startDesktop} from '../scripts/local-demo.mjs';
import {createModelDecision} from '../src/model-transport.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=t=>{const dir=mkdtempSync(join(tmpdir(),'threadline-setup-'));return dir;};

test('download setup starts offline, saves private profile, imports notes, and runs the real model protocol with a simulated provider',async t=>{
 const directory=temp(t),key='sk-test-abcdefghijklmnop',requests=[];
 const makeModel=options=>createModelDecision({...options,networkCheck:async()=>({ok:true}),transport:async(_u,init)=>{
  const body=JSON.parse(init.body);requests.push({body,authorization:init.headers.authorization});
  const input=JSON.parse(body.messages[1].content);
  return new Response(JSON.stringify({id:'synthetic-provider-id',created:1,model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({packetId:input.packetId,decision:{type:'reply',text:'测试回复'}})}}],
   usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}}),{status:200});
 }});
 const desktop=createDesktop({root,directory,makeModel,providerFetch:async()=>new Response('{}',{status:200})});
 let running=await startDesktop({desktop});
 try{
  const url=running.url,origin=new URL(url).origin;
  const post=(path,value,from=origin)=>fetch(url+'api/'+path,{method:'POST',headers:{origin:from,'content-type':'application/json'},body:JSON.stringify(value)});
  const page=await fetch(url);assert.match(await page.text(),/Threadline/);
  assert.equal((await fetch(url+'style.css')).status,200);
  assert.equal((await post('chat',{text:'离线'},'https://example.invalid')).status,403);
  const state=await (await fetch(url+'api/state')).json();
  assert.equal(state.profile.live,false);
  const offline=await post('chat',{text:'离线消息'});assert.equal(offline.status,200);assert.equal((await offline.json()).live,false);assert.equal(requests.length,0);
  assert.equal((await post('check-key',{key})).status,200);
  assert.equal(requests.length,0);
  assert.deepEqual(await (await post('import',{notes:['喜欢纸飞机','喜欢纸飞机']})).json(),{imported:1,duplicates:1});
  assert.equal((await post('import',{notes:['有效项',{body:'',kind:'nonsense'}]})).status,400);
  assert.deepEqual((await (await fetch(url+'api/notes')).json()).notes,[{body:'喜欢纸飞机',kind:'interpretation'}]);
  const profile={...state.profile,live:true,identity:'你是一个测试馆员。',style:'说话像一个馆员。'};
  const apply=await post('apply',{profile,key});assert.equal(apply.status,200,await apply.clone().text());
  const reply=await post('chat',{text:'在线一轮'});assert.equal(reply.status,200,await reply.clone().text());
  assert.equal((await reply.json()).text,'测试回复');
  assert.equal(requests.length,1);assert.match(JSON.stringify(requests[0].body),/测试馆员/);assert.match(JSON.stringify(requests[0].body),/像一个馆员/);
  assert.equal(requests[0].authorization,'Bearer '+key);
  assert.doesNotMatch(readFileSync(join(directory,'settings.json'),'utf8'),/sk-test/);
  assert.doesNotMatch(await (await fetch(url+'api/state')).text(),/sk-test/);
  await running.stop();running=null;
  running=await startDesktop({desktop:createDesktop({root,directory,makeModel})});
  const after=await (await fetch(running.url+'api/state')).json();assert.equal(after.profile.live,false);assert.equal(after.hasKey,false);assert.equal(after.profile.identity,profile.identity);
 }finally{await running?.stop();rmSync(directory,{recursive:true,force:true});}
});

test('local spending reserves before dispatch and keeps unknowns across restart',t=>{
 const dir=temp(t),path=join(dir,'requests.json'),now=()=>Date.UTC(2026,0,2);
 let j=new DesktopJournal(path,100,now);const time=Date.now;
 // RequestJournal timestamps real time; use the same day in the gate.
 j.clock=time;
 try{
  j.reserve('a','hash',70);j.dispatch('a');j.uncertain('a','provider');
  assert.throws(()=>j.reserve('b','hash',31),{code:'DESKTOP_BUDGET_LIMIT'});
  j.close();j=new DesktopJournal(path,100,time);
  assert.equal(j.usage().estimate,.00007);
  j.reserve('b','hash',30);j.dispatch('b');j.settle('b',{upperMicros:10});
  assert.equal(j.usage().estimate,.00008);
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});

test('Limbic configuration reaches the actual worker and preserves the initialized profile',async t=>{
 const executable=process.env.JY_AFFECT_PYTHON;if(!executable)return t.skip('test requires the optional Python interpreter');
 const directory=temp(t),desktop=createDesktop({root,directory});await desktop.initialize();
 try{
  const profile={...desktop.state().profile,affect:true,fusion:true,python:executable,parameters:{reactivity:1.2}};
  await desktop.apply({profile});
  assert.equal(desktop.state().affect.enabled,true);
  assert.equal(desktop.state().affect.fusion,true);
  await desktop.say('初始化情绪状态');
  await assert.rejects(desktop.apply({profile:{...profile,parameters:{reactivity:1.3}}}),{code:'LIMBIC_PROFILE_LOCKED'});
 }finally{await desktop.stop();rmSync(directory,{recursive:true,force:true});}
});

test('QQ connection verifies the account from the configured SDK before showing Connected; disconnect does not send',async t=>{
 const directory=temp(t),sdk=join(directory,'fake-sdk.mjs'),home=join(directory,'onebot');
 mkdirSync(join(home,'config'),{recursive:true});writeFileSync(join(home,'config','onebot_70001.json'),JSON.stringify({networks:{httpServers:[{host:'127.0.0.1',port:1}],wsServers:[{host:'127.0.0.1',port:1}]}}));
 writeFileSync(sdk,`export class SnowLumaWebSocketClient{
  on(){} onPrivateMessage(){} onGroupMessage(){} onNotice(){} onBotStatus(){} async connect(){this.timer=setInterval(()=>{},1000)} async getLoginInfo(){return{user_id:70001}} async close(){clearInterval(this.timer)}
 }`);
 const desktop=createDesktop({root,directory});
 try{
  await desktop.initialize();
  await desktop.apply({profile:{...desktop.state().profile,live:true,qq:{bot:'70001',owner:'70002',home,sdk}},key:'sk-test-abcdefghijklmnop'});
  assert.equal((await desktop.connectQQ()).status,'connecting');
  for(let i=0;i<40&&desktop.state().qqStatus==='connecting';i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(desktop.state().qqStatus,'connected');
  await desktop.stopQQ();assert.equal(desktop.state().qqStatus,'off');
 }finally{await desktop.stop();rmSync(directory,{recursive:true,force:true});}
});

