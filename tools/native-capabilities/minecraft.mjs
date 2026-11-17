import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {toolContract} from '../../src/tool-contracts.mjs';
let link,starting=null,startError=null,host=null;const bad=message=>Object.assign(new Error(message),{code:'MINECRAFT_NOT_READY',transportInvoked:false});
export function configureMinecraftHost(options){if(typeof options?.onBatch!=='function'||typeof options?.busy!=='function')throw bad('host observation handoff required');host=options;}
export async function tickMinecraft(){if(host&&link)await link.tick();}
export function minecraftCatalogResult(result){return {...result,entryContract:{tool:'qq_minecraft',...toolContract('qq_minecraft')},meaning:'这是工具说明，不是移动或施工回执；已包含外层调用契约。需要子工具完整参数时用catalog并指定其name，取得后可直接call。'};}
async function configured(){
 if(link)return link;
 const file=process.env.JY_MINECRAFT_CONFIG;if(!file||!existsSync(file))throw bad('operator-selected single-player world is not configured');
 const c=JSON.parse(readFileSync(file,'utf8'));
 if(c.format!=='jingyang-v15-approved-minecraft-v1'||c.version!=='26.1'||c.host!=='127.0.0.1'||!existsSync(join(c.world,'level.dat'))||!existsSync(join(c.backup,'level.dat')))throw bad('approved world and its backup could not be verified');
 const {MinecraftLink}=await import(pathToFileURL(join(c.legacyBridge,'src/minecraft-link.js')).href);
 link=new MinecraftLink({directory:c.companionDirectory,dataDirectory:process.env.JY_MINECRAFT_STATE??join(c.companionDirectory,'state'),getConfig:()=>({enabled:true,actionsEnabled:true,supportEnabled:false,studyEnabled:false,backend:'native',host:c.host,port:c.port,version:c.version,username:c.username,ownerUsername:c.ownerUsername}),allowed:()=>true,busy:()=>host?.busy()??true,onBatch:(...args)=>host?.onBatch(...args)??false,log:message=>console.error('[minecraft]',String(message).slice(0,400))});return link;
}
export function normalizeMinecraftCall(name,args={}){
 if(name!=='mc_do'||Array.isArray(args.steps))return args;
 if(args.macro==='chat'&&typeof args.text==='string')return {...args,steps:[{skill:'chat',text:args.text}]};
 if(typeof args.chat==='string')return {...args,steps:[{skill:'chat',text:args.chat}]};
 return args;
}
export async function runMinecraft(input={},context={}){
 if(!process.env.JY_MINECRAFT_CONFIG){if((input.action??'status')==='status')return {available:false,connected:false,reason:'no operator-selected world'};throw bad('no operator-selected world');}
 const l=await configured(),action=input.action??'status';
 if(action==='status')return {...l.status(),starting:!!starting,startError,usage:toolContract('qq_minecraft').usage};
 if(action==='start'){
  if(!starting){startError=null;starting=l.start().catch(error=>{startError=String(error.message).slice(0,600);}).finally(()=>{starting=null;});}
  return {...l.status(),starting:!!starting,startRequested:true,meaning:'connection startup requested; this is not proof of world readiness or gameplay; query status before calling tools'};
 }
 if(action==='stop'){await l.stop();return {stopped:true,meaning:'owned companion stopped; host world left intact'};}
 if(action==='catalog'){if(!l.status().engineReady)throw bad('本客户端尚未连接；用户的世界宿主与本客户端是两个进程。可用action=status查看启动原因，或在依赖就绪后自行决定action=start。此次没有查询游戏目录或执行游戏动作。');return minecraftCatalogResult(await l.request({action:'catalog',name:input.name}));}
 if(action==='call'){const operation=context.action?.id??(context.task?.id?context.task.id+':'+context.task.stepCount:null);if(!operation)throw bad('committed Action or task step required; requestId must not be invented');return l.request({action:'call',name:input.name,args:normalizeMinecraftCall(input.name,input.args??{}),requestId:operation});}
 throw bad('unsupported Minecraft action');
}
export async function closeMinecraft(){await link?.close();}
