// 原生 MC：复用旧 MinecraftLink/协议；不经过旧 DSH，不接旧 brain。
import {MinecraftLink, minecraftConfig} from '../../../整理版_2026-10-16/qq-bridge/src/minecraft-link.js';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const legacy=fileURLToPath(new URL('../../../整理版_2026-10-16/qq-bridge/',import.meta.url));
const cfg=JSON.parse(readFileSync(resolve(legacy,'config.json'),'utf8')).minecraft??{};
const link=new MinecraftLink({
  directory:resolve(legacy,'..','minecraft-companion'),
  getConfig:()=>({...cfg,enabled:true,supportEnabled:false,backend:'native',host:'127.0.0.1',port:Number(cfg.port??34824),version:String(cfg.version??'26.1'),username:String(cfg.username??'Agent'),ownerUsername:String(cfg.ownerUsername??'Owner')}),
  allowed:()=>true,busy:()=>false,onBatch:async()=>false,
  log:message=>console.error('[mc-native]',String(message).slice(0,300)),
});
export async function runMinecraft(input={}){
  const action=input.action??'status';
  if(action==='status')return link.status();
  if(action==='catalog')return link.request({action:'catalog',name:input.name});
  if(action==='call')return link.request({action:'call',name:input.name,args:input.args??{},requestId:input.requestId});
  if(action==='start')return link.start();
  if(action==='stop')return link.stop();
  throw new Error('unknown minecraft action');
}