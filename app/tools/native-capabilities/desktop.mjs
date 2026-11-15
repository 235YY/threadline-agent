// 原生桌宠：通过 THREADLINE_DESKTOP_MODULE 动态加载外部模块；不绑定写死路径。
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

let linkPromise=null;
async function getLink(){
  const modPath=process.env.THREADLINE_DESKTOP_MODULE;
  if(!modPath)throw new Error('desktop companion module not configured (set THREADLINE_DESKTOP_MODULE)');
  if(!linkPromise){
    linkPromise=(async()=>{
      const {DesktopLink}=await import(pathToFileURL(resolve(modPath)).href);
      const dataRoot=process.env.AGENT_DATA?resolve(process.env.AGENT_DATA):resolve(process.cwd(),'data');
      return new DesktopLink({
        directory:process.env.THREADLINE_DESKTOP_DIR?resolve(process.env.THREADLINE_DESKTOP_DIR):resolve(dataRoot,'desktop-companion'),
        logDirectory:resolve(dataRoot,'desktop'),
        enabled:()=>true,renderer:()=>'animation',
      });
    })();
  }
  return linkPromise;
}
export async function runDesktop(input={}){
  const link=await getLink();
  const action=input.action??'status';
  if(action==='status')return link.status();
  if(action==='start')return link.start();
  if(action==='stop')return link.stop();
  return link.request(action,input.args??{});
}