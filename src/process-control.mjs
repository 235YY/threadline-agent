import {readFileSync,existsSync} from 'node:fs';

// Explicit local stop mailbox for processes started by our launcher, never a model tool.
export function installProcessControl(stop,{path=process.env.JY_CONTROL_FILE,token=process.env.JY_CONTROL_TOKEN,intervalMs=500}={}){
  if(!path||!token)return ()=>{};
  let stopping=false;
  const timer=setInterval(async()=>{
    if(stopping||!existsSync(path))return;
    let request;try{request=JSON.parse(readFileSync(path,'utf8'));}catch{return;}
    if(request.token!==token||request.pid!==process.pid||request.command!=='stop')return;
    stopping=true;clearInterval(timer);try{await stop();}catch(error){console.error(error.code??'PROCESS_STOP_FAILED');}
  },intervalMs);timer.unref();return ()=>clearInterval(timer);
}
