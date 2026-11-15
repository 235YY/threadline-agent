import {openSync,writeFileSync,fsyncSync,closeSync,unlinkSync,readFileSync,mkdirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
// Local controlled launch guard. This is not a cross-host lease or rollback witness.
export function claimConnector({root,botId}={}){
 if(!root||!isAbsolute(root)||!/^\d+$/.test(String(botId)))throw Error('CONNECTOR_GUARD_CONFIG');
 mkdirSync(root,{recursive:true});const path=join(root,`qq-${botId}.lock`),instanceId=randomUUID();let fd;
 try{fd=openSync(path,'wx');}catch{throw Object.assign(Error('connector ownership exists; inspect before recovery'),{code:'CONNECTOR_OWNED'});}
 try{writeFileSync(fd,JSON.stringify({instanceId,pid:process.pid,botId:String(botId),startedAt:new Date().toISOString()}));fsyncSync(fd);}catch(e){closeSync(fd);throw e;}
 let closed=false;return {path,instanceId,close(){if(closed)return;closed=true;closeSync(fd);let current;try{current=JSON.parse(readFileSync(path,'utf8'));}catch{return;}if(current.instanceId===instanceId)unlinkSync(path);}};
}
