import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TOOL_NAMES,BASE_TOOL_NAMES,UNAVAILABLE_TOOLS,oneBotCall,executeTool} from '../tools/qq-connect/tools.mjs';
import {configureLifeTools} from '../tools/open-life/tools.mjs';
import {openLifePolicy} from '../tools/open-life/policy.mjs';
import {toolContract} from '../src/tool-contracts.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';
import {keepAttention} from '../src/attention.mjs';
import {resolveBrainConfig} from '../tools/brain-service/runtime-config.mjs';
import {studyKey} from '../src/model-credential.mjs';

// Golden ordered inventory from frozen local Recovery 004, not a permission list.
const expected=[
 'qq_send_message','qq_send_private_message','qq_send_group_message','qq_get_group_history','qq_get_friend_history','qq_get_group_members','qq_list_groups','qq_list_friends',
 'qq_list_stickers','qq_send_sticker','qq_send_voice','qq_send_poke','qq_get_forward_msg','qq_necklace','qq_watch_video','qq_pet','qq_minecraft','qq_speak','qq_list_voices','qq_sticker_note',
 'attention_mute','attention_unmute','attention_load','attention_status','anchor_recall','style_status','style_update','style_delete','web_search','web_fetch',
 'office_status','office_list','office_read','office_search','office_audit','github_status','github_repo','github_issues','github_issue','github_pulls','github_branches',
 'office_write','office_edit','office_run','office_npm','office_plugin_list','office_plugin_run','office_plugin_install','github_create_branch','github_put_file','github_create_pr',
 'tool_contract','qq_send_image','qq_get_group_info','bilibili_search','bilibili_video_meta','bilibili_comments','bilibili_column_text','github_search','github_repo_readme','github_repo_tree','github_issue_read','github_release_read'
];
const extension=expected.slice(51),publicReads=extension.slice(3);
function mode(t,value){const old=process.env.JY_OPEN_LIFE;process.env.JY_OPEN_LIFE=value;t.after(()=>{if(old===undefined)delete process.env.JY_OPEN_LIFE;else process.env.JY_OPEN_LIFE=old;});}
const noPolicy={restrictPrivateRead(){},assertOperationCurrent(){}};
const reply=(p,tool=null)=>JSON.stringify({packetId:p.packetId,options:[{id:'o',kind:tool?'act':'wait',payload:tool?{tool,args:{query:'synthetic'}}:{}}],selected:'o',summary:'offline release boundary',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}});

test('unconfigured registered extensions report a dependency failure before any external call',async t=>{
 mode(t,'0');
 await assert.rejects(executeTool('github_search',{query:'synthetic'}),{code:'LIFE_NOT_READY',transportInvoked:false});
 process.env.JY_OPEN_LIFE='1';
 await assert.rejects(executeTool('github_search',{query:'synthetic'}),{code:'LIFE_NOT_READY',transportInvoked:false});
});

test('public registry exactly matches the 63 frozen names; 12 added names have real contracts',()=>{
 assert.equal(expected.length,63);assert.deepEqual(TOOL_NAMES,expected);assert.deepEqual(BASE_TOOL_NAMES,expected.slice(0,51));
 assert.equal(new Set(TOOL_NAMES).size,63);assert.equal(typeof oneBotCall,'function');assert.ok(UNAVAILABLE_TOOLS.includes('qq_speak'));
 for(const name of extension){const c=toolContract(name);assert.ok(c?.purpose,name);assert.equal(c.inputSchema.type,'object');assert.equal(c.version,1);}
 assert.deepEqual(toolContract('qq_send_image').inputSchema.required,['target','id','url']);
 assert.deepEqual(toolContract('tool_contract').inputSchema.required,['name']);
});

test('extensions enter the real Life dispatcher first with unchanged context and parameters',async t=>{
 mode(t,'1');const seen=[],context={action:{id:'offline-action',revision:1},allowedTools:['github_repo_tree']};
 configureLifeTools({policy:{restrictPrivateRead:(name,args,c)=>seen.push({name,args,c}),assertOperationCurrent:r=>assert.equal(r,context.action)},
  onebot:async(action,args)=>({action,args}),public:{call:async(name,args)=>({name,args})}});
 const samples={bilibili_search:{query:'q'},bilibili_video_meta:{bvid:'BV1xx411c7mD'},bilibili_comments:{bvid:'BV1xx411c7mD'},bilibili_column_text:{id:1},
  github_search:{query:'q'},github_repo_readme:{repo:'example/project'},github_repo_tree:{repo:'example/project'},github_issue_read:{repo:'example/project',number:1},github_release_read:{repo:'example/project'}};
 for(const name of publicReads){const args=samples[name];assert.deepEqual(await executeTool(name,args,context),{name,args});assert.equal(seen.at(-1).c,context);assert.equal(seen.at(-1).args,args);}
 assert.deepEqual(await executeTool('qq_get_group_info',{group_id:'9'},context),{action:'get_group_info',args:{group_id:9}});
 const detail=await executeTool('tool_contract',{name:'github_repo_tree'},context);assert.equal(detail.id,'github_repo_tree');assert.equal(detail.authorized,true);
 await assert.rejects(executeTool('tool_contract',{name:'qq_send_image'},context),{code:'TOOL_NOT_GRANTED',transportInvoked:false});
});

test('actual public image dispatcher preserves target validation and persistent duplicate-send protection',async t=>{
 mode(t,'1');const dir=mkdtempSync(join(tmpdir(),'jy-public-send-')),rows=[
  {id:'e',revision:1,type:'event',origin:'observed',scene:'qq/private/7'},
  {id:'d',revision:1,type:'decision',currentEvent:{id:'e',revision:1},input:{payload:{continuity:{subject:{id:'jingyang'}}}},action:{id:'a',revision:1}},
  {id:'a',revision:1,type:'action',inputRefs:[{id:'e',revision:1}]}];
 const store={read:(id,rev)=>rows.find(x=>x.id===id&&(rev===undefined||x.revision===rev)),all:type=>rows.filter(x=>x.type===type)};
 const policy=openLifePolicy({file:join(dir,'policy.json'),botId:'1',ownerId:'7',store:()=>store});let calls=0,actual;
 configureLifeTools({policy,knownTargets:async()=>new Set(['qq/private/7']),fetchImage:async()=>({buffer:Buffer.from('synthetic bytes')}),
  onebot:async(action,args)=>{calls++;actual={action,args};return {message_id:42};}});
 const args={target:'private',id:'7',url:'https://example.invalid/image'},context={action:{id:'a',revision:1}};
 assert.equal((await executeTool('qq_send_image',args,context)).message_id,42);
 assert.equal((await executeTool('qq_send_image',args,context)).message_id,42);assert.equal(calls,1);
 assert.equal(actual.action,'send_private_msg');assert.equal(actual.args.user_id,7);assert.equal(actual.args.group_id,undefined);
 assert.match(actual.args.message[0].data.file,/^base64:\/\//);
 await assert.rejects(executeTool('qq_send_image',{...args,id:'8'},context),{code:'QQ_SCOPE'});
 await assert.rejects(executeTool('qq_send_image',{...args,target:'private:7'},context),{code:'TOOL_ARGUMENTS',transportInvoked:false});
 assert.equal(calls,1);
});

test('registering new tools does not authorize an ungranted Decision',async()=>{
 let executions=0;const service=createBrainService({storePath:':memory:',global:true,allowedActionTools:[],heartbeatMs:0,adapter:{act:async()=>{executions++;}},
  decide:p=>reply(p,'github_search')});
 try{const r=await service.reply({scene:'synthetic',key:'denied',message_id:'1',messages:[{role:'user',content:'offline denial'}]});
  assert.equal(r.ok,false);assert.equal(r.error,'TOOL_NOT_GRANTED');assert.equal(executions,0);assert.equal([...service.store.all('action')].length,0);
 }finally{service.close();}
});

test('optional public-read failure becomes a failed receipt and does not block the next source',async t=>{
 mode(t,'1');let external=0;const seen=[];
 configureLifeTools({policy:noPolicy,onebot:()=>{external++;throw Error('must not send');},public:{call:()=>{throw Object.assign(Error('public adapter unavailable'),{code:'PUBLIC_READ_UNAVAILABLE',transportInvoked:false});}}});
 const service=createBrainService({storePath:':memory:',global:true,allowedActionTools:['github_search'],heartbeatMs:0,
  adapter:{act:({tool,args,action,scene})=>executeTool(tool,args,{action,scene,allowedTools:['github_search']})},
  decide:p=>{seen.push(p.payload.current.body);return reply(p,p.payload.current.body==='offline read'?'github_search':null);}});
 try{
  assert.equal((await service.reply({scene:'synthetic',key:'read',message_id:'1',messages:[{role:'user',content:'offline read'}]})).ok,true);
  const action=[...service.store.all('action')][0];assert.equal(action.status,'failed');assert.match(service.store.read(action.receipt.id).body,/PUBLIC_READ_UNAVAILABLE/);
  await service.reply({scene:'synthetic',key:'next',message_id:'2',messages:[{role:'user',content:'new source'}]});
  for(let i=0;i<3&&!seen.includes('new source');i++)await service.turn();
  assert.ok(seen.includes('new source'));assert.equal(external,0);
 }finally{service.close();}
});

test('standard configuration and credential contract agree with the documented entry',()=>{
 const config=resolveBrainConfig({env:{BRAIN_LIVE:'1',JY_LIVE_CONFIRM:'YES',BRAIN_LEDGER:'isolated-requests.json',JY_AFFECT:'0'}});
 assert.equal(config.rhythm.dailyCallCap,null);assert.ok(config.ledgerPath.endsWith('isolated-requests.json'));
 let spawned=0;assert.throws(()=>studyKey({available:()=>false,spawn:()=>{spawned++;}}),{code:'STUDY_KEY_REQUIRED'});assert.equal(spawned,0);
 const docs=readFileSync(new URL('../docs/CONFIGURATION.md',import.meta.url),'utf8');
 for(const text of ['RequestJournal','JY_OFFICIAL_USAGE_TOKEN','90秒','5分钟','5元','DPAPI'])assert.ok(docs.includes(text),text);
 assert.match(readFileSync(new URL('../README.md',import.meta.url),'utf8'),/node tools\/brain-service\/run.mjs/);
 assert.match(readFileSync(new URL('../tools/ops/start.ps1',import.meta.url),'utf8'),/LEGACY/);
 assert.ok(!readFileSync(new URL('../.env.example',import.meta.url),'utf8').includes('DEEPSEEK_API_KEY='));
});

test('private original replay is explicit and never selected by the public default runner',()=>{
 const selection=JSON.parse(readFileSync(new URL('../scripts/current-test-files.json',import.meta.url),'utf8'));
 assert.ok(selection.files.includes('test/public-release-contract.test.mjs'));assert.ok(!selection.files.some(x=>x.includes('/private/')));
 const env={...process.env,JY_PRIVATE_REPLAY_ROOT:''};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--test','test/private/investigation-history.test.mjs'],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',windowsHide:true});
 assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/JY_PRIVATE_REPLAY_ROOT is required/);
});
