// Offline dry-run demonstration of the Threadline Agent brain service.
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {assertSupportedNode} from '../tools/brain-service/runtime-config.mjs';

assertSupportedNode();
const dir=mkdtempSync(join(tmpdir(),'threadline-demo-'));
const sent=[];
let service;
try{
  service=await startBrainService({
    port:0,
    storePath:join(dir,'demo.sqlite'),
    stateDirectory:join(dir,'state'),
    global:true,
    heartbeatMs:0,
    adapter:{send:async({scene,text})=>{sent.push({scene,text});return {delivered:true};}}
  });
  const result=await service.reply({
    scene:'qq/private/demo-user',
    key:'private:demo-user',
    source:'qq',
    message_id:'demo-1',
    execute:true,
    messages:[{role:'user',content:'在吗？这是一条离线演示消息。'}]
  });
  console.log(JSON.stringify({demo:'offline-dry-run',ok:result.ok,scene:result.scene,silent:result.silent,delivered:sent.length},null,2));
}finally{
  if(service?.server?.listening)await new Promise(resolve=>service.server.close(resolve));
  service?.close();
  rmSync(dir,{recursive:true,force:true});
}
