import {existsSync,readFileSync,realpathSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {toolContract,validateToolArguments} from '../../src/tool-contracts.mjs';
import {publicTools} from './public-tools.mjs';
import * as office from './office.mjs';
import {safeFetchBuffer} from './safe-fetch.mjs';

const publicNames=new Set(['github_search','github_repo_readme','github_repo_tree','github_issue_read','github_release_read','bilibili_search','bilibili_video_meta','bilibili_comments','bilibili_column_text']);
const sendNames=new Set(['qq_send_message','qq_send_sticker','qq_send_image','qq_send_voice','qq_speak']);
const bad=(code,message)=>Object.assign(new Error(message),{code,transportInvoked:false});
let services;
export function configureLifeTools(options){if(!options?.policy||!options.onebot)throw bad('LIFE_CONFIG','host policy and real OneBot adapter required');services={public:publicTools(),...options};}
export async function handleLifeTool(name,args,context={}){
 if(!services)throw bad('LIFE_NOT_READY','open-life tools have not been configured by the host');
 validateToolArguments(name,args);services.policy.restrictPrivateRead(name,args,context);
 services.policy.assertOperationCurrent(context.action??context.response);
 if(name==='tool_contract'){
  const allowed=context.task?context.allowedTools:context.allowedTools??[];
  if(!allowed.includes(args.name))throw bad('TOOL_NOT_GRANTED','that tool is not authorized for this cognition entry');
  const contract=toolContract(args.name);if(!contract)throw bad('CONTRACT_UNAVAILABLE','tool parameters were not confirmed; do not guess');
  return {handled:true,value:{id:args.name,...contract,authorized:true,meaning:'usage contract only; execution still checks current permissions and dependencies'}};
 }
 if(publicNames.has(name))return {handled:true,value:await services.public.call(name,args)};
 if(name==='qq_minecraft'){const module=await import('../native-capabilities/minecraft.mjs');return {handled:true,value:await module.runMinecraft(args,context)};}
 if(name.startsWith('office_')){
  const root=services.officeRoot;if(!root||!existsSync(root))throw bad('OFFICE_UNAVAILABLE','designated workspace is unavailable');
  if(args.path&&/(^|[\\/])(?:\.env(?:\..*)?|\.git|\.aws|secrets?|credentials?|private-audit|.*\.dpapi)([\\/]|$)/i.test(args.path))throw bad('OFFICE_PRIVATE_PATH','credentials and private control files are outside office capability');
  let value;const input={...args,root};
  if(name==='office_status')value={root,capabilities:['list','read','search','write','edit'],commandExecution:false,harnessConnector:'not-available-in-this-runtime',boundary:'designated local file workspace; no inherited Codex OAuth or personal cloud access'};
  else if(name==='office_list')value=office.listOffice(input);
  else if(name==='office_read')value=office.readOffice(input);
  else if(name==='office_search')value=office.searchOffice(input);
  else if(name==='office_write')value=office.writeOffice(input);
  else if(name==='office_edit')value=office.editOffice(input);
  else throw bad('TOOL_NOT_GRANTED','office commands, plugins and installs are not part of this grant');
  return {handled:true,value};
 }
 if(name==='qq_get_group_info')return {handled:true,value:await services.onebot('get_group_info',{group_id:Number(args.group_id)})};
 if(name==='qq_list_voices'){
  if(!services.voiceDirectory)throw bad('VOICE_DEPENDENCY_UNCONFIRMED','voice directory is not configured');
  const items=readdirSync(services.voiceDirectory,{withFileTypes:true}).filter(x=>x.isFile()&&/\.(mp3|wav|ogg|silk|amr)$/i.test(x.name)).slice(0,Math.min(20,args.limit??20)).map(x=>({name:x.name,file:resolve(services.voiceDirectory,x.name)}));
  return {handled:true,value:{items,scope:'existing generated voice files only',synthesisEnabled:false}};
 }
 if(sendNames.has(name)){
  if(!['private','group'].includes(args.target)||!/^\d+$/.test(String(args.id)))throw bad('QQ_TARGET_ARGUMENTS','explicit private/group recipient required');
  const targetScene=`qq/${args.target}/${args.id}`;
  const knownTargets=await services.knownTargets();
  services.policy.key(context);
  if(!knownTargets.has(targetScene))throw bad('QQ_SCOPE','target is not an actual friend or joined group');
  if(name==='qq_speak')throw bad('VOICE_DEPENDENCY_UNCONFIRMED','speech synthesis has not been verified; no send was attempted');
  let message;
  if(name==='qq_send_voice'){
   if(!services.voiceDirectory)throw bad('VOICE_DEPENDENCY_UNCONFIRMED','voice directory is not configured');
   const file=realpathSync(resolve(args.file)),root=realpathSync(services.voiceDirectory),rel=relative(root,file);
   if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw bad('VOICE_SCOPE','voice file is outside the authorized voice directory');
   if(!/\.(mp3|wav|ogg|silk|amr)$/i.test(file)||!statSync(file).isFile()||statSync(file).size>10*1024*1024)throw bad('VOICE_SCOPE','only bounded audio files may be sent');
   message=[{type:'record',data:{file}}];
  }else if(name==='qq_send_sticker'||name==='qq_send_image'){
   const url=new URL(args.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw bad('IMAGE_SOURCE','only a public image address may be sent');
   let image;try{image=await (services.fetchImage??safeFetchBuffer)(url.href,4*1024*1024);}catch(error){error.transportInvoked=false;throw error;}
   if(!Buffer.isBuffer(image.buffer))throw bad('IMAGE_SOURCE','image was not obtained as a verified bounded public image');
   message=[{type:'image',data:{file:'base64://'+image.buffer.toString('base64')}}];
  }else message=[{type:'text',data:{text:String(args.text??'')}}];
  const invoke=()=>services.onebot(args.target==='private'?'send_private_msg':'send_group_msg',{[args.target==='private'?'user_id':'group_id']:Number(args.id),message});
  return {handled:true,value:await services.policy.send({tool:name,args,context,targetScene,knownTargets,invoke})};
 }
 return {handled:false};
}
