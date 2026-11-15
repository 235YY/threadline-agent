// 新 QQ 能力宿主：直接走 OneBot HTTP，不经过旧 bridge。
// 只执行显式工具调用；没有角色卡、记忆、社交决策。
import {readFileSync,writeFileSync,readdirSync,existsSync,statSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {githubConfig,createGitHubClient} from '../../src/github.mjs';
import {readAccount} from './account.mjs';
import {validateToolArguments} from '../../src/tool-contracts.mjs';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const SNOW=process.env.SNOWLUMA_HOME??resolve(PROJECT,'../SnowLuma/dist');
function legacyBridge(){if(!process.env.JY_LEGACY_BRIDGE_ROOT)throw Object.assign(Error('Optional integration adapter is not configured; set JY_LEGACY_BRIDGE_ROOT after reviewing and installing it'),{code:'TOOL_DEPENDENCY_MISSING',transportInvoked:false});return resolve(process.env.JY_LEGACY_BRIDGE_ROOT);}
const STICKERS=process.env.QQ_STICKERS_FILE??resolve(PROJECT,'config/stickers.example.json');
const BRAIN_URL=process.env.BRAIN_URL??'http://127.0.0.1:8787';
const BRAIN_TOKEN=process.env.BRAIN_TOKEN??'';
const OFFICE_URL=process.env.OFFICE_WORKER_URL??'http://127.0.0.1:8791';
const OFFICE_TOKEN_FILE=resolve(PROJECT,'_local/ops/office.token');
function officeToken(){return process.env.OFFICE_WORKER_TOKEN??(()=>{try{return readFileSync(OFFICE_TOKEN_FILE,'utf8').trim();}catch{return '';}})();}

function account(){try{const a=readAccount({home:SNOW,uin:process.env.QQ_UIN});return {uin:a.uin,base:a.httpUrl,token:String(a.http.accessToken??'')};}catch(error){error.transportInvoked=false;throw error;}}
async function call(action,params={}){
  const a=account();
  const r=await fetch(`${a.base}/${action}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(a.token?{authorization:`Bearer ${a.token}`}:{})},body:JSON.stringify(params)});
  const body=await r.json().catch(()=>null);
  if(!r.ok||body?.status==='failed'||(body?.retcode!==undefined&&body.retcode!==0))throw new Error(`${action}: ${body?.message??body?.wording??r.status}`);
  if(action.startsWith('send_')&&(body?.status!=='ok'||body?.retcode!==0||body?.data?.message_id===undefined))throw Object.assign(Error('send receipt has no confirmed message_id'),{code:'ONEBOT_SEND_UNCONFIRMED'});
  return body?.data??body;
}
async function officeCall(tool,args={}){
  let response;try{response=await fetch(OFFICE_URL+'/call',{method:'POST',headers:{'content-type':'application/json',...(officeToken()?{'x-office-token':officeToken()}:{})},body:JSON.stringify({tool,args}),signal:AbortSignal.timeout(35000)});}catch(error){throw Object.assign(new Error('office worker unavailable: '+error.message),{code:'OFFICE_UNAVAILABLE'});}
  const body=await response.json().catch(()=>null);if(!response.ok||!body?.ok)throw new Error('office worker: '+(body?.message??body?.error??response.status));return body.result;
}
const unsentError=(message,code='TOOL_PREFLIGHT')=>Object.assign(new Error(message),{code,transportInvoked:false});
async function githubTool(op,args={}){
  let cfg;try{cfg=githubConfig({secretPath:process.env.GITHUB_SECRET??resolve(PROJECT,'_local/ops/github.json')});}catch(error){error.transportInvoked=false;throw error;}
  if(op==='status')return {configured:cfg.configured,writable:cfg.writable,owner:cfg.owner,repo:cfg.repo};
  if(!cfg.configured)throw unsentError('github owner/repo not configured','GITHUB_NOT_CONFIGURED');
  const gh=createGitHubClient(cfg);
  if(op==='repo')return gh.repoInfo();
  if(op==='issues')return gh.issues({state:args.state,limit:args.limit});
  if(op==='issue')return gh.issue(args.number);
  if(op==='pulls')return gh.pulls({state:args.state,limit:args.limit});
  if(op==='branches')return gh.branches(args.limit);
  if(op==='create_branch')return gh.createBranch(args.branch,{from:args.from??'main'});
  if(op==='put_file')return gh.putFile({branch:args.branch,path:args.path,content:args.content,message:args.message});
  if(op==='create_pr')return gh.createPull({title:args.title,body:args.body??'',head:args.head,base:args.base??'main'});
  throw unsentError('github operation not granted: '+op,'TOOL_ARGUMENTS');
}
const textSeg=t=>({type:'text',data:{text:String(t)}});
export const targetArgs=(a={})=>{
  const target=a.target??(a.group_id?'group':a.user_id?'private':null);
  const id=a.id??a.group_id??a.user_id;
  if(!['private','group'].includes(target)||!/^\d+$/.test(String(id??'')))throw Object.assign(Error('QQ_TARGET_ARGUMENTS: target must be private or group; id must be the decimal recipient QQ/group number, not a sticker id or a private:QQ scene; url is the sticker image address. No QQ request was sent.'),{code:'QQ_TARGET_ARGUMENTS',transportInvoked:false});
  return {target,id:String(id)};
};
async function send(a){
  const {target,id}=targetArgs(a);const message=Array.isArray(a.message)?a.message:[textSeg(a.text??'')];
  return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message}:{user_id:Number(id),message});
}
function plainMessage(m){
  const segs=Array.isArray(m?.message)?m.message:[];
  return segs.map(s=>s?.type==='text'?s.data?.text??'':s?.type==='image'?'[图片]':s?.type==='face'?'[表情]':s?.type==='record'?'[语音]':s?.type==='at'?`@${s.data?.qq??''}`:'').join('').trim()||String(m?.raw_message??'');
}
export const TOOL_NAMES=Object.freeze([
  'qq_send_message','qq_send_private_message','qq_send_group_message',
  'qq_get_group_history','qq_get_friend_history','qq_get_group_members','qq_list_groups','qq_list_friends',
  'qq_list_stickers','qq_send_sticker','qq_send_voice','qq_send_poke','qq_get_forward_msg','qq_necklace','qq_watch_video','qq_pet','qq_minecraft','qq_speak','qq_list_voices','qq_sticker_note','attention_mute','attention_unmute','attention_load','attention_status','anchor_recall','style_status','style_update','style_delete','web_search','web_fetch','office_status','office_list','office_read','office_search','office_audit','github_status','github_repo','github_issues','github_issue','github_pulls','github_branches','office_write','office_edit','office_run','office_npm','office_plugin_list','office_plugin_run','office_plugin_install','github_create_branch','github_put_file','github_create_pr',
]);

async function speak(args={}){
  const legacy=legacyBridge();
  const {speechPlan,synthesizeMinimax}=await import(pathToFileURL(join(legacy,'src/companion-life/speech.js')).href);
  const cfg=JSON.parse(readFileSync(join(legacy,'config.json'),'utf8'));
  const plan=speechPlan(cfg.socialV2?.life?.speech??{provider:'minimax'},args,{maxChars:160});
  const dir=join(legacy,'audio/generated');mkdirSync(dir,{recursive:true});
  const file=join(dir,`tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  const synth=await synthesizeMinimax({root:legacy,plan,output:file});
  const {target,id}=targetArgs(args);
  await call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'record',data:{file}}]}:{user_id:Number(id),message:[{type:'record',data:{file}}]});
  return {...synth,file,delivered:true};
}
async function listVoices(args={}){
  const legacy=legacyBridge();
  const {listAudioFiles}=await import(pathToFileURL(join(legacy,'src/voice-core.js')).href);
  return listAudioFiles(join(legacy,'audio')).slice(0,Number(args.limit??30));
}
async function stickerNote(args={}){
  if(!existsSync(STICKERS))throw unsentError('sticker library missing','STICKER_LIBRARY_MISSING');
  const list=JSON.parse(readFileSync(STICKERS,'utf8'));
  const item=list.find(s=>s.id===args.id);
  if(!item)throw unsentError('sticker not found','TOOL_ARGUMENTS');
  if(typeof args.note==='string')item.localNote=args.note.slice(0,800);
  if(Array.isArray(args.tags))item.tags=args.tags.filter(x=>typeof x==='string').slice(0,12);
  item.updatedAt=new Date().toISOString();
  writeFileSync(STICKERS,JSON.stringify(list,null,2)+'\n','utf8');
  return {id:item.id,desc:item.desc,localNote:item.localNote,tags:item.tags,updatedAt:item.updatedAt};
}
async function brainJson(path,body=null,method='POST'){
  const response=await fetch(BRAIN_URL+path,{method,headers:{'content-type':'application/json',...(BRAIN_TOKEN?{'x-brain-token':BRAIN_TOKEN}:{})},...(body!==null?{body:JSON.stringify(body)}:{})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.error??`brain ${response.status}`);
  return value;
}
async function webTool(name,toolArgs){  const legacy=legacyBridge();
  const {Client}=await import(pathToFileURL(join(legacy,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
  const {StdioClientTransport}=await import(pathToFileURL(join(legacy,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(legacy,'src/mcp-web-search-safe.js')],cwd:legacy,stderr:'pipe'});
  const client=new Client({name:'qq-capability-host',version:'1.0.0'});
  try{await client.connect(transport);const result=await client.callTool({name,arguments:toolArgs});
    const text=(result?.content??[]).map(x=>x?.text??'').join('\n');
    if(name==='web_fetch'&&(/JFIF|Exif\u0000|\uFFFD\uFFFD\uFFFD/i.test(text)||/"contentType"\s*:\s*"image\//i.test(text))){
      return {content:[{type:'text',text:JSON.stringify({url:toolArgs?.url??null,error:'BINARY_RESPONSE',note:'binary/image response omitted from text; use the message ContentPart image instead'})}],isError:true};
    }
    return result;
  }
  finally{try{await client.close();}catch{}}
}
export function stickerPage(list,args={}){
  const requested=Number(args.limit??30),offset=Number(args.offset??0),query=String(args.query??'').trim().toLocaleLowerCase('zh-CN');
  if(!Number.isSafeInteger(requested)||requested<1||!Number.isSafeInteger(offset)||offset<0||query.length>100)throw Error('STICKER_PAGE_ARGS');
  const limit=Math.min(32,requested),all=list.filter(s=>s.url&&(!query||[s.desc,s.usage,s.localNote,...(s.tags??[])].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(query)));
  const items=[];let bytes=0;
  for(const s of all.slice(offset,offset+limit)){
    const item={id:s.id,desc:s.desc,usage:s.usage,localNote:s.localNote,tags:s.tags,url:s.url},size=Buffer.byteLength(JSON.stringify(item));
    if(bytes+size>12000){if(!items.length)throw Error('STICKER_ITEM_TOO_LARGE');break;}items.push(item);bytes+=size;
  }
  return {format:'sticker-page-v1',sendContract:{tool:'qq_send_sticker',target:'private or group only',id:'decimal recipient QQ/group number; NOT item.id',url:'item.url; item.id identifies the sticker, not its recipient'},items,total:all.length,offset,nextOffset:offset+items.length<all.length?offset+items.length:null,
    meaning:'bounded current catalog page; use offset for next page or query to filter; this is not a historical receipt snapshot'};
}
export function readStickerPage(path,args={}){
 if(!existsSync(path))throw Object.assign(Error('本地表情库文件缺失；没有完成查询，不能据此判断没有匹配表情'),{code:'STICKER_LIBRARY_MISSING',transportInvoked:false});
 return stickerPage(JSON.parse(readFileSync(path,'utf8')),args);
}
export async function executeTool(tool,args={}){
  validateToolArguments(tool,args);
  switch(tool){
    case 'qq_send_message':return send(args);
    case 'qq_send_private_message':return send({...args,target:'private'});
    case 'qq_send_group_message':return send({...args,target:'group'});
    case 'qq_list_groups':return (await call('get_group_list')).map(g=>({group_id:g.group_id,group_name:g.group_name,member_count:g.member_count}));
    case 'qq_list_friends':return (await call('get_friend_list')).map(f=>({user_id:f.user_id,nickname:f.nickname,remark:f.remark??''}));
    case 'qq_get_group_members':{
      const gid=args.group_id??args.id;if(!gid)throw unsentError('group_id required','TOOL_ARGUMENTS');
      return (await call('get_group_member_list',{group_id:Number(gid)})).map(m=>({user_id:m.user_id,nickname:m.nickname,card:m.card}));
    }
    case 'qq_get_group_history':{
      const gid=args.group_id??args.id;if(!gid)throw unsentError('group_id required','TOOL_ARGUMENTS');
      const count=Math.max(1,Math.min(20,Number(args.count??5)));
      const data=await call('get_group_msg_history',{group_id:Number(gid),count});
      return (data.messages??[]).map(m=>({message_id:m.message_id,time:m.time,user_id:m.user_id,nickname:m.sender?.nickname??'',text:plainMessage(m)}));
    }
    case 'qq_get_friend_history':{
      const uid=args.user_id??args.id;if(!uid)throw unsentError('user_id required','TOOL_ARGUMENTS');
      const count=Math.max(1,Math.min(20,Number(args.count??5)));
      const data=await call('get_friend_msg_history',{user_id:Number(uid),count});
      return (data.messages??[]).map(m=>({message_id:m.message_id,time:m.time,user_id:m.user_id,text:plainMessage(m)}));
    }
    case 'qq_get_forward_msg':{
      if(!args.id)throw unsentError('forward id required','TOOL_ARGUMENTS');
      return call('get_forward_msg',{id:String(args.id)});
    }
    case 'qq_list_stickers':{
      return readStickerPage(STICKERS,args);
    }
    case 'qq_send_sticker':{
      const {target,id}=targetArgs(args);const url=args.url??args.sticker;
      if(!url)throw unsentError('sticker url required','TOOL_ARGUMENTS');
      return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'image',data:{file:String(url)}}]}:{user_id:Number(id),message:[{type:'image',data:{file:String(url)}}]});
    }
    case 'qq_send_voice':{
      const {target,id}=targetArgs(args);const file=args.file;
      if(!file||!existsSync(file))throw unsentError('voice file required','TOOL_ARGUMENTS');
      return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'record',data:{file:String(file)}}]}:{user_id:Number(id),message:[{type:'record',data:{file:String(file)}}]});
    }
    case 'qq_necklace':{const {runNecklace}=await import('../native-capabilities/necklace/adapter.mjs');return runNecklace(args);}
    case 'qq_watch_video':{const {runVideo}=await import('../native-capabilities/video/adapter.mjs');return runVideo(args);}
    case 'qq_pet':{const {runDesktop}=await import('../native-capabilities/desktop.mjs');return runDesktop(args);}
    case 'qq_minecraft':{const {runMinecraft}=await import('../native-capabilities/minecraft.mjs');return runMinecraft(args);}
    case 'qq_speak':return speak(args);
    case 'qq_list_voices':return listVoices(args);
    case 'qq_sticker_note':return stickerNote(args);
    case 'attention_mute':return brainJson('/v1/attention/mute',{prefix:args.prefix});
    case 'attention_unmute':return brainJson('/v1/attention/unmute',{prefix:args.prefix,load:args.load!==false});
    case 'attention_load':return brainJson('/v1/attention/load',{prefix:args.prefix,limit:args.limit??50});
    case 'attention_status':return brainJson('/v1/attention',null,'GET');
    case 'anchor_recall':return brainJson('/v1/anchor/query',{anchor:args.anchor,role:args.role??null,limit:args.limit??12});
    case 'style_status':return brainJson('/v1/style',null,'GET');
    case 'style_update':return brainJson('/v1/style',{text:args.text,label:args.label,source:args.source??'agent'});
    case 'style_delete':return brainJson('/v1/style/delete',{id:args.id});
    case 'web_search':return webTool('web_search',{query:args.query,maxResults:args.maxResults??5});
    case 'web_fetch':return webTool('web_fetch',{url:args.url});
    case 'office_status':return officeCall('office_status',args);
    case 'office_list':return officeCall('office_list',args);
    case 'office_read':return officeCall('office_read',args);
    case 'office_search':return officeCall('office_search',args);
    case 'office_audit':return officeCall('office_audit',args);
    case 'office_write':return officeCall('office_write',args);
    case 'office_edit':return officeCall('office_edit',args);
    case 'office_run':return officeCall('office_run',args);
    case 'office_npm':return officeCall('office_npm',args);
    case 'office_plugin_list':return officeCall('office_plugin_list',args);
    case 'office_plugin_run':return officeCall('office_plugin_run',args);
    case 'office_plugin_install':return officeCall('office_plugin_install',args);
    case 'github_status':return githubTool('status',args);
    case 'github_repo':return githubTool('repo',args);
    case 'github_issues':return githubTool('issues',args);
    case 'github_issue':return githubTool('issue',args);
    case 'github_pulls':return githubTool('pulls',args);
    case 'github_branches':return githubTool('branches',args);
    case 'github_create_branch':return githubTool('create_branch',args);
    case 'github_put_file':return githubTool('put_file',args);
    case 'github_create_pr':return githubTool('create_pr',args);
    case 'qq_send_poke':{
      if(!args.user_id)throw unsentError('user_id required','TOOL_ARGUMENTS');
      return call('send_poke',{user_id:Number(args.user_id),...(args.group_id?{group_id:Number(args.group_id)}:{})});
    }
    default:throw unsentError(`tool not migrated: ${tool}`,'TOOL_NOT_SUPPORTED');
  }
}
