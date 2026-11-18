import {installProcessControl} from '../../src/process-control.mjs';
import {readAccount} from './account.mjs';
import {claimConnector} from './connector-guard.mjs';
// 纯 QQ 传输连接器：SnowLuma OneBot WS ↔ 新脑 /v1/reply。
// 这里没有角色卡、记忆、社交决策、主动策略；只做消息搬运。旧脑不参与。
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const sdkPath=process.env.QQ_SDK_MODULE??new URL('../../../整理版_2026-10-16/qq-bridge/node_modules/@snowluma/sdk/dist/index.js',import.meta.url).href;
const {SnowLumaWebSocketClient}=await import(sdkPath);
import {buildReplyPayload} from './bridge-payload.mjs';
import {message as jyMessage,textPart,imagePart,projectText} from '../../src/message.mjs';
import {safeFetchBuffer} from './safe-fetch.mjs';
import {acceptsChat,canStopAll,isGroupAddressed,noticeScene} from './scope.mjs';
import {MessageReceiver} from './receive.mjs';
import {shouldStopConnector} from './bridge-policy.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const project=resolve(here,'../..');
const snowHome=process.env.SNOWLUMA_HOME??resolve(project,'../SnowLuma/dist');
const brainUrl=process.env.BRAIN_URL??'http://127.0.0.1:8787';
const brainToken=process.env.BRAIN_TOKEN??'';
const wantUin=process.env.QQ_UIN??null;
const ownerQQ=process.env.QQ_OWNER??process.env.QQ_TEST_ONLY_OWNER??null;
const chatScope=process.env.QQ_CHAT_SCOPE??'owner-test';
const log=(...args)=>console.log(new Date().toISOString(),...args);

function pickAccount(){return readAccount({home:snowHome,uin:wantUin});}
const WAKE=(process.env.QQ_WAKE_KEYWORDS??'鲸鱼,小鲸鱼,鲸漾,在吗').split(',').map(s=>s.trim()).filter(Boolean);
const groupPolicy=process.env.QQ_GROUP_POLICY??'all';
function addressed(event){
  return isGroupAddressed(event,{selfId,policy:groupPolicy,wakeKeywords:WAKE});
}
function messageText(event){
  const parts=Array.isArray(event.message)?event.message.filter(s=>s?.type==='text').map(s=>s.data?.text??''):[];
  return parts.join('').trim();
}

const account=pickAccount();
const selfId=Number(account.uin);
if(!/^\d+$/.test(String(ownerQQ??'')))throw Error('QQ_OWNER_REQUIRED');
const connectorGuard=claimConnector({root:process.env.QQ_CONNECTOR_LOCK_ROOT,botId:account.uin});
let identityReady=false;let actualChats=new Set();
async function refreshAccess(){const [friends,groups]=await Promise.all([onebot('get_friend_list'),onebot('get_group_list')]);actualChats=new Set([...friends.map(x=>'qq/private/'+x.user_id),...groups.map(x=>'qq/group/'+x.group_id)]);}
async function onebot(action,params={}){
  const base=`http://${account.http?.host||'127.0.0.1'}:${account.http?.port||3000}`;
  const r=await fetch(`${base}/${action}`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',...(account.http?.accessToken?{authorization:`Bearer ${account.http.accessToken}`}:{})},body:JSON.stringify(params)});
  const b=await r.json().catch(()=>null);if(!r.ok||b?.status==='failed'||(b?.retcode!==undefined&&b.retcode!==0))throw new Error(`${action}: ${b?.message??b?.wording??r.status}`);return b?.data??b;
}
function plain(message){const segs=Array.isArray(message?.message)?message.message:Array.isArray(message?.content)?message.content:[];return segs.map(x=>x?.type==='text'?x.data?.text??'':x?.type==='at'?`@${x.data?.name??x.data?.qq??''}`:x?.type==='image'?'[图片]':x?.type==='face'?'[表情]':x?.type==='record'?'[语音]':' ').join('').trim()}
async function resolveContext(payload){
  if(payload.replyTo){try{const m=await onebot('get_msg',{message_id:payload.replyTo});const name=m?.sender?.card||m?.sender?.nickname||m?.sender?.user_id||'原消息';const body=plain(m);if(body)payload.messages[0].content=`[引用 ${name}：${body.slice(0,800)}]\n${payload.messages[0].content}`;}catch{payload.messages[0].content=`[引用消息：${payload.replyTo}]\n${payload.messages[0].content}`;}}
  if(payload.forwardId){try{const f=await onebot('get_forward_msg',{id:payload.forwardId});const items=Array.isArray(f?.messages)?f.messages:Array.isArray(f?.content)?f.content:[];const text=items.slice(0,12).map(x=>plain(x)).filter(Boolean).join(' / ').slice(0,1600);if(text)payload.messages[0].content+=`\n[合并转发：${text}]`;}catch{payload.messages[0].content+=`\n[合并转发：${payload.forwardId}]`;}}
  return payload;
}
const bot=new SnowLumaWebSocketClient({url:`ws://${account.ws.host||'127.0.0.1'}:${account.ws.port||3001}/`,accessToken:account.ws.accessToken??'',reconnect:true});
const seen=new Set();
let chain=Promise.resolve(),stopping=false,pollTimer=null,pollTask=null;
const reconcileMs=Number(process.env.QQ_RECEIVE_RECONCILE_MS??0);
if(!Number.isSafeInteger(reconcileMs)||reconcileMs!==0&&(reconcileMs<5000||reconcileMs>60000))throw Error('QQ_RECEIVE_CONFIG');
const receiver=new MessageReceiver({selfId,stateFile:join(process.env.BRAIN_STATE??resolve(project,'_local/brain/state'),`qq-receive-${selfId}.json`),
  since:process.env.QQ_RECEIVE_SINCE?Number(process.env.QQ_RECEIVE_SINCE):Date.now(),diagnose:(stage,data)=>log(stage,JSON.stringify(data))});
installProcessControl(async()=>{stopping=true;clearInterval(pollTimer);await pollTask?.catch(()=>{});await chain.catch(()=>{});await bot.close?.();connectorGuard.close();process.exit(0);});
function once(id){if(seen.has(id))return false;seen.add(id);if(seen.size>500){const first=seen.values().next().value;seen.delete(first);}return true;}

async function brainRequest(path,body){
  const response=await fetch(brainUrl+path,{method:'POST',headers:{'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok||value.error)throw Object.assign(Error(value.message??value.error??'brain request failed'),{code:value.error??'BRAIN_REQUEST'});return value;
}
async function materializeMessage(payload){
  const content=[];let buffer='';
  const flush=()=>{if(buffer){content.push(textPart(buffer));buffer='';}};
  for(const part of payload.parts??[]){
    if(part.type==='text'){buffer+=part.text;continue;}
    if(part.type==='image'){
      buffer+='[图片]';flush();
      if(!part.url)continue;
      try{
        const media=await safeFetchBuffer(part.url);
        const bytes=media.bytes;
        const mediaType=media.mediaType;
        const up=await fetch(brainUrl+'/v1/blob',{method:'POST',headers:{'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})},body:JSON.stringify({bytes:bytes.toString('base64'),mediaType})});
        if(!up.ok)throw new Error('blob '+up.status);
        const blob=await up.json();content.push(imagePart({ref:blob.ref,hash:blob.hash,mediaType:blob.mediaType,bytes:blob.bytes,sourceUrl:media.url}));
      }catch(error){content.push(textPart('[图片未取到]'));log('image-error',error.message);}
    }
  }
  flush();
  const context=payload.messages?.[0]?.content??'';
  const quote=context.match(/^\[引用[^\n]*\]\n?/)?.[0]??'';
  const forward=context.match(/\n\[合并转发[^\n]*\]$/)?.[0]??'';
  if(quote)content.unshift(textPart(quote.trim()+'\n'));
  if(forward){if(content.at(-1)?.type==='text')content.at(-1).text+=forward;else content.push(textPart(forward));}
  if(content.length===0)content.push(textPart(context));
  payload.message=jyMessage('user',content);
  payload.messages=[{role:'user',content:projectText(payload.message)}];
  return payload;
}
async function handle(event,ctx){
  const payload=buildReplyPayload(event,{selfId,ownerId:ownerQQ});payload.execute=true;const text=payload.messages[0]?.content??'';if(!text)return;
  const privateChat=event.message_type==='private';
  const ownerOnly=process.env.QQ_TEST_ONLY_OWNER;
  if(!acceptsChat({privateChat,userId:event.user_id},{scope:chatScope,ownerOnly}))return;
  if(privateChat&&canStopAll(event.user_id,ownerQQ)&&/^\/(stop|停止任务)$/i.test(text)){await fetch(`${brainUrl}/v1/tasks/stop-all`,{method:'POST',headers:{'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})},body:JSON.stringify({reason:'explicit user stop'})}).catch(()=>{});return;}
  if(!addressed(event))return;
  const scene=privateChat?`qq/private/${event.user_id}`:`qq/group/${event.group_id}`;
  const key=privateChat?`private:${event.user_id}`:`group:${event.group_id}`;
  if(!once(`${scene}:${event.message_id}`))return;
  const sender={system:'qq',id:String(event.user_id),name:String(event.sender?.card||event.sender?.nickname||event.user_id),
    entityId:`person:qq:${event.user_id}`,isOwner:String(event.user_id)===String(ownerQQ)};
  const occurredAt=Number.isSafeInteger(event.time)?event.time*1000:Date.now();
  await resolveContext(payload);
  await materializeMessage(payload);
  const response=await fetch(`${brainUrl}/v1/reply`,{method:'POST',headers:{'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})},
    body:JSON.stringify(payload)});
  if(!response.ok)throw new Error(`brain ${response.status} ${await response.text()}`);
  const result=await response.json();
  if(result.error)throw Object.assign(new Error(`brain ${result.error}: ${result.message??''}`),{code:result.error,...(result.processingOutcome?{processingOutcome:result.processingOutcome}:{})});
  // Brain is the sole egress owner, including durable claims and real receipts.
  // The connector only transports incoming messages and acknowledges admission.
  log(privateChat?'private':'group',scene,'in',text.length,'out',result.text?result.text.length:0,'silent',result.silent===true);
  return result;
}

function enqueueIncoming(event,ctx,source='push'){
  if(chatScope==='all'&&!actualChats.has(event.message_type==='private'?`qq/private/${event.user_id}`:`qq/group/${event.group_id}`))return Promise.resolve({ignored:true,reason:'not-an-actual-friend-or-group'});
  if(!identityReady)return Promise.reject(Object.assign(Error('Bot identity not verified'),{code:'QQ_IDENTITY_NOT_READY'}));
  if(stopping)return Promise.reject(Object.assign(Error('receiver is stopping'),{code:'RECEIVE_STOPPING'}));
  if(process.env.QQ_ACCEPT_SINCE&&Number(event.time)*1000<Number(process.env.QQ_ACCEPT_SINCE))return Promise.resolve({ignored:true,reason:'before-approved-test-window'});
  if(!acceptsChat({privateChat:event.message_type==='private',userId:event.user_id},{scope:chatScope,ownerOnly:process.env.QQ_TEST_ONLY_OWNER}))return Promise.resolve({ignored:true});
  const next=chain.then(()=>receiver?receiver.accept(event,{source,deliver:e=>handle(e,ctx)}):handle(event,ctx));
  chain=next.catch(error=>{if(shouldStopConnector(error)){stopping=true;log('connector-stop',error.code??error.name,error.message);return;}log('message-failure-continue',error.code??error.name,error.message);});return next;
}
bot.onPrivateMessage((event,ctx)=>enqueueIncoming(event,ctx).catch(()=>{}));
bot.onGroupMessage((event,ctx)=>enqueueIncoming(event,ctx).catch(()=>{}));
bot.on('error',error=>log('qq-stream-error',error.code??error.name,error.message));
bot.on('close',info=>log('qq-stream-closed',JSON.stringify(info)));
let chatCache=[],chatCacheAt=0,chatOffset=0;const chatRetryAfter=new Map();
async function reconcileIncoming(){
  if(stopping||!receiver)return;
  if(Date.now()-chatCacheAt>60000){
    const friends=await onebot('get_friend_list'),groups=await onebot('get_group_list');
    if(!Array.isArray(friends)||!Array.isArray(groups))throw Error('RECEIVE_CHAT_LIST_INVALID');
    const known=new Map();
    for(const [kind,items,field] of [['private',friends,'user_id'],['group',groups,'group_id']])for(const item of items){
      const id=String(item[field]);if(!/^\d+$/.test(id))throw Error('RECEIVE_CHAT_ID_INVALID');
      if(kind==='private'&&id===String(selfId))continue;
      if(acceptsChat({privateChat:kind==='private',userId:id},{scope:chatScope,ownerOnly:process.env.QQ_TEST_ONLY_OWNER}))known.set(`${kind}:${id}`,{kind,id});
    }
    chatCache=[...known.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));chatCacheAt=Date.now();
    if(chatScope==='all')actualChats=new Set(chatCache.map(c=>'qq/'+c.kind+'/'+c.id));
  }
  const count=Math.min(8,chatCache.length);
  for(let i=0;i<count&&!stopping;i++){
    const chat=chatCache[chatOffset++%chatCache.length];
    const key=`${chat.kind}:${chat.id}`;if((chatRetryAfter.get(key)??0)>Date.now())continue;
    try{await receiver.reconcile(chat,{fetchHistory:async(c,limit)=>{
      const data=await onebot(c.kind==='private'?'get_friend_msg_history':'get_group_msg_history',{[c.kind==='private'?'user_id':'group_id']:Number(c.id),count:limit});
      if(!Array.isArray(data?.messages))throw Error('RECEIVE_HISTORY_INVALID');return data.messages;
    },enqueue:(event,source)=>enqueueIncoming(event,{reply:message=>event.message_type==='private'?bot.sendPrivateMessage(event.user_id,message):bot.sendGroupMessage(event.group_id,message)},source)});}
    catch(error){chatRetryAfter.set(key,Date.now()+60000);log('receive-check-error',key,error.code??error.name,error.message);}
  }
}
function scheduleReceiveCheck(){
  if(stopping||pollTask)return;
  pollTask=reconcileIncoming().catch(error=>log('receive-check-error',error.code??error.name,error.message)).finally(()=>{pollTask=null;});
}
bot.onNotice(async event=>{
  if(!identityReady||stopping)return;
  const type=String(event?.notice_type??'');
  if(!['group_recall','friend_recall','group_poke','friend_poke','notify'].includes(type))return;
  const scene=noticeScene(event);if(!scene||chatScope==='all'&&!actualChats.has(scene))return;
  const privateChat=scene.startsWith('qq/private/');
  const ownerOnly=process.env.QQ_TEST_ONLY_OWNER;
  if(!acceptsChat({privateChat,userId:event.user_id},{scope:chatScope,ownerOnly}))return;
  const body=type.endsWith('_recall')?`[撤回] ${event.message_id??''}`:type.endsWith('_poke')?`[拍一拍] ${event.target_id??event.user_id??''}`:`[${type}]`;
  const sender={system:'qq',id:String(event.user_id??event.operator_id??'0'),name:String(event.user_id??event.operator_id??'qq'),entityId:`person:qq:${event.user_id??event.operator_id??'0'}`,isOwner:String(event.user_id??event.operator_id??0)===String(ownerQQ)};
  try{await fetch(`${brainUrl}/v1/observe`,{method:'POST',headers:{'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})},body:JSON.stringify({protocol:'jingyang-brain-bridge-v1',key:privateChat?`private:${event.user_id}`:`group:${event.group_id}`,scene,text:body,sender,occurredAt:Number.isSafeInteger(event.time)?event.time*1000:Date.now()})});}catch(error){log('notice-error',type,error.message);}
});
bot.onBotStatus(event=>log('bot-status',event.sub_type??'',event.user_id??''));

for(;;){
  try{await bot.connect();break;}
  catch(error){log('connect-retry',error.message);await new Promise(resolve=>setTimeout(resolve,15000));}
}
const login=await bot.getLoginInfo();
if(String(login.user_id)!==account.uin){await bot.close?.();throw Error('QQ_IDENTITY_MISMATCH');}
if(chatScope==='all')await refreshAccess();
identityReady=true;
log('connected',login.user_id,login.nickname,'brain',brainUrl,'scope',chatScope);
if(receiver&&reconcileMs>0){log('receive-reconciliation','enabled',reconcileMs,'ms','floor',receiver.data.since);pollTimer=setInterval(scheduleReceiveCheck,reconcileMs);scheduleReceiveCheck();}
if(reconcileMs===0)log('receive-persistence','push-only; history polling disabled');
process.on('SIGINT',async()=>{log('stopping');await bot.close?.();connectorGuard.close();process.exit(0);});
process.on('SIGTERM',async()=>{log('stopping');await bot.close?.();connectorGuard.close();process.exit(0);});
