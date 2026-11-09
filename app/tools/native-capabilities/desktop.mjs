// 原生桌宠：复用旧 DesktopLink/动画协议；不经过旧 DSH。
import {DesktopLink} from '../../../整理版_2026-10-16/qq-bridge/src/desktop-link.js';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const legacy=fileURLToPath(new URL('../../../整理版_2026-10-16/qq-bridge/',import.meta.url));
const link=new DesktopLink({
  directory:resolve(legacy,'..','desktop-companion'),
  logDirectory:resolve(legacy,'..','..','智能体框架','_local','desktop'),
  enabled:()=>true,renderer:()=>'animation',
});
export async function runDesktop(input={}){
  const action=input.action??'status';
  if(action==='status')return link.status();
  if(action==='start')return link.start();
  if(action==='stop')return link.stop();
  return link.request(action,input.args??{});
}