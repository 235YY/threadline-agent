// 原生 MC：通过 THREADLINE_MINECRAFT_MODULE 动态加载外部模块；不绑定写死路径。
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

let linkPromise=null;
async function getLink(){
  const modPath=process.env.THREADLINE_MINECRAFT_MODULE;
  if(!modPath)throw new Error('minecraft companion module not configured (set THREADLINE_MINECRAFT_MODULE)');
  if(!linkPromise){
    linkPromise=(async()=>{
      const {MinecraftLink}=await import(pathToFileURL(resolve(modPath)).href);
      const dataRoot=process.env.AGENT_DATA?resolve(process.env.AGENT_DATA):resolve(process.cwd(),'data');
      const cfgPath=process.env.THREADLINE_MINECRAFT_CONFIG?resolve(process.env.THREADLINE_MINECRAFT_CONFIG):resolve(dataRoot,'minecraft.json');
      const cfg=existsSync(cfgPath)?JSON.parse(readFileSync(cfgPath,'utf8')):{};
      return new MinecraftLink({
        directory:process.env.THREADLINE_MINECRAFT_DIR?resolve(process.env.THREADLINE_MINECRAFT_DIR):resolve(dataRoot,'minecraft-companion'),
        getConfig:()=>({...cfg,enabled:true,supportEnabled:false,backend:'native',host:String(cfg.host??'127.0.0.1'),port:Number(cfg.port??34824),version:String(cfg.version??'26.1'),username:String(cfg.username??'Agent'),ownerUsername:String(cfg.ownerUsername??'Owner')}),
        allowed:()=>true,busy:()=>false,onBatch:async()=>false,
        log:message=>console.error('[mc-native]',String(message).slice(0,300)),
      });
    })();
  }
  return linkPromise;
}
export async function runMinecraft(input={}){
  const link=await getLink();
  const action=input.action??'status';
  if(action==='status')return link.status();
  if(action==='catalog')return link.request({action:'catalog',name:input.name});
  if(action==='call')return link.request({action:'call',name:input.name,args:input.args??{},requestId:input.requestId});
  if(action==='start')return link.start();
  if(action==='stop')return link.stop();
  throw new Error('unknown minecraft action');
}