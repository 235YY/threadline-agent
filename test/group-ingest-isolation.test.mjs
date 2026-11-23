import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {acceptsChat,allowedGroupSet,blockedChatSet} from '../tools/qq-connect/scope.mjs';
import {recentContext} from '../src/recent-context.mjs';

const attention={processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]};
const output=(packet,text='在的')=>JSON.stringify({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text}}],selected:'r',
  summary:'group ingest fixture',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}});

async function start(t,extra={}){
  const service=await startBrainService({token:'t',clock:()=>1000,decide:p=>output(p),...extra});
  t.after(async()=>{await new Promise(r=>service.server.close(r));service.close();});
  return service;
}
const caller=service=>async body=>{
  const response=await fetch(service.url+'/v1/reply',{method:'POST',headers:{'content-type':'application/json','x-brain-token':'t'},
    body:JSON.stringify({protocol:'jingyang-brain-bridge-v1',...body})});
  return response.json();
};
const post=service=>async(path,body)=>{
  const response=await fetch(service.url+path,{method:'POST',headers:{'content-type':'application/json','x-brain-token':'t'},body:JSON.stringify(body)});
  return response.json();
};
function withGroupIngest(t,value='off'){
  const previous=process.env.JY_GROUP_INGEST;
  if(value===undefined)delete process.env.JY_GROUP_INGEST;else process.env.JY_GROUP_INGEST=value;
  t.after(()=>{if(previous===undefined)delete process.env.JY_GROUP_INGEST;else process.env.JY_GROUP_INGEST=previous;});
}
const groupReply=(call,id,text='群里的话')=>call({scene:'qq/group/9',key:'group:9',message_id:id,messages:[{role:'user',content:text}]});

test('群消息只记录：100 条全部进入事件流，0 次模型调用，0 条收件箱',async t=>{
  withGroupIngest(t);
  let calls=0;
  const service=await start(t,{decide:packet=>{calls+=1;return output(packet);}});
  const call=caller(service);
  for(let i=0;i<100;i++){
    const body=await groupReply(call,`g-${i}`,`群消息 ${i}`);
    assert.equal(body.ok,true);assert.equal(body.queued,false);assert.equal(body.silent,true);assert.equal(body.text,'');
  }
  assert.equal(calls,0,'group messages must not reach the model');
  assert.equal([...service.store.all('event')].filter(e=>e.scene==='qq/group/9').length,100);
  assert.equal(service.store.subjectInbox({subjectId:'jingyang',limit:64}).items.length,0);
});

test('observe-only 的 /v1/reply 不处理其他场景的待办',async t=>{
  withGroupIngest(t);
  let calls=0;
  const service=await start(t,{decide:packet=>{calls+=1;return output(packet);}});
  const call=caller(service);
  const queued=await service.observe({source:'qq',key:'private:1',text:'先来的私聊'});
  assert.equal(queued.queued,true);
  const silent=await groupReply(call,'g-1');
  assert.equal(silent.queued,false);assert.equal(silent.text,'');assert.equal(calls,0);
  assert.deepEqual(service.health().pending.map(p=>p.key),['qq/private/1'],'private work must stay queued, not be consumed');
  const drained=await service.turn({preferred:'qq/private/1'});
  assert.equal(drained.scene,'qq/private/1');assert.equal(calls,1);
});

test('recent-context 排除未被主体接收的原始群消息',async t=>{
  withGroupIngest(t);
  const service=await start(t);
  const call=caller(service);
  await service.observe({source:'qq',key:'private:1',text:'已入收件箱'});
  await groupReply(call,'g-1','只在事件流');
  const admitted=recentContext({store:service.store,subjectId:'jingyang',scene:'qq/private/1'});
  assert.deepEqual(admitted.items.map(item=>item.text),['已入收件箱']);
  const isolated=recentContext({store:service.store,subjectId:'jingyang',scene:'qq/group/9'});
  assert.equal(isolated.items.length,0);
});

test('unmute 默认不补历史，显式 load=true 才补',async t=>{
  withGroupIngest(t);
  let calls=0;
  const service=await start(t,{decide:packet=>{calls+=1;return output(packet);}});
  const call=caller(service),send=post(service);
  await service.mute('qq/group/9');
  for(let i=0;i<3;i++)await groupReply(call,`g-${i}`,`积压 ${i}`);
  assert.equal(service.attention().backlog,3);
  assert.equal(service.health().pending.length,0);
  await send('/v1/attention/unmute',{prefix:'qq/group/9'});
  assert.equal(service.attention().backlog,3,'default unmute must not load the backlog');
  assert.equal(service.health().pending.length,0);
  assert.equal(calls,0);
  await send('/v1/attention/unmute',{prefix:'qq/group/9',load:true});
  assert.equal(service.attention().backlog,0);
  assert.deepEqual(service.health().pending.map(item=>[item.key,item.count]),[['qq/group/9',3]]);
  assert.equal(service.store.subjectInbox({subjectId:'jingyang',limit:64}).items.length,3);
  assert.equal(calls,0,'loading a backlog queues work, it must not call the model by itself');
});

test('群白名单只放行指定群，主人私聊保持原样，屏蔽仍优先',()=>{
  const allowed=allowedGroupSet({QQ_ALLOWED_GROUPS:'123, 456'});
  assert.deepEqual([...allowed],['qq/group/123','qq/group/456']);
  assert.equal(acceptsChat({privateChat:true,userId:'7'},{scope:'all',ownerOnly:'7',blockedChats:new Set(),allowedGroups:allowed}),true);
  assert.equal(acceptsChat({privateChat:true,userId:'8'},{scope:'all',ownerOnly:'7',blockedChats:new Set(),allowedGroups:allowed}),false);
  assert.equal(acceptsChat({privateChat:false,groupId:'123'},{scope:'all',ownerOnly:'7',blockedChats:new Set(),allowedGroups:allowed}),true);
  assert.equal(acceptsChat({privateChat:false,groupId:'999'},{scope:'all',ownerOnly:'7',blockedChats:new Set(),allowedGroups:allowed}),false);
  assert.equal(acceptsChat({privateChat:false,groupId:'123'},{scope:'all',ownerOnly:'7',blockedChats:blockedChatSet({QQ_BLOCKED_GROUPS:'123'}),allowedGroups:allowed}),false);
  assert.equal(acceptsChat({privateChat:true,userId:'7'},{scope:'all',ownerOnly:'7'}),true);
  assert.equal(acceptsChat({privateChat:true,userId:'8'},{scope:'owner-test',ownerOnly:'7'}),false);
  assert.equal(acceptsChat({privateChat:false,groupId:'9'},{scope:'owner-test',ownerOnly:'7'}),false);
});

test('主人私聊收发行为不变',async t=>{
  const sent=[];
  const service=await start(t,{decide:packet=>output(packet,'在呢'),adapter:{send:async outbound=>{sent.push(outbound);return {delivered:true};}}});
  const call=caller(service);
  const body=await call({scene:'qq/private/7',key:'private:7',message_id:'p-1',messages:[{role:'user',content:'在吗'}]});
  assert.equal(body.ok,true);assert.equal(body.silent,false);assert.equal(body.text,'在呢');
  assert.equal(sent.length,1);assert.equal(sent[0].scene,'qq/private/7');
});

test('qq_get_group_history 通过既有工具回执链路返回消息',async t=>{
  const home=mkdtempSync(join(tmpdir(),'qq-history-test-'));
  mkdirSync(join(home,'config'));
  writeFileSync(join(home,'config','onebot_123.json'),JSON.stringify({networks:{
    httpServers:[{host:'127.0.0.1',port:3999}],wsServers:[{host:'127.0.0.1',port:3998}]}}));
  const previousHome=process.env.SNOWLUMA_HOME,previousUin=process.env.QQ_UIN,realFetch=globalThis.fetch;
  process.env.SNOWLUMA_HOME=home;process.env.QQ_UIN='123';
  const seen=[];
  globalThis.fetch=async(url,init)=>{
    seen.push({url:String(url),body:JSON.parse(init.body)});
    return new Response(JSON.stringify({status:'ok',retcode:0,data:{messages:[{message_id:7,time:1700000000,user_id:42,
      sender:{nickname:'甲'},message:[{type:'text',data:{text:'群历史'}}]}]}}),{status:200,headers:{'content-type':'application/json'}});
  };
  t.after(()=>{
    globalThis.fetch=realFetch;
    if(previousHome===undefined)delete process.env.SNOWLUMA_HOME;else process.env.SNOWLUMA_HOME=previousHome;
    if(previousUin===undefined)delete process.env.QQ_UIN;else process.env.QQ_UIN=previousUin;
    rmSync(home,{recursive:true,force:true});
  });
  const {executeTool}=await import('../tools/qq-connect/tools.mjs?group-history-test=1');
  const messages=await executeTool('qq_get_group_history',{group_id:'9',count:3},{allowedTools:['qq_get_group_history'],entry:'decision'});
  assert.deepEqual(messages,[{message_id:7,time:1700000000,user_id:42,nickname:'甲',text:'群历史'}]);
  assert.equal(seen[0].url,'http://127.0.0.1:3999/get_group_msg_history');
  assert.deepEqual(seen[0].body,{group_id:9,count:3});
});
