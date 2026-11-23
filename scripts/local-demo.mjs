
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDesktop,ranges} from './local-desktop.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function startDesktop({desktop=createDesktop({root})}={}){
 const assets=new Map([['','index.html','text/html'],['style.css','style.css','text/css'],['app.js','app.js','application/javascript']]
  .map(([path,file,type])=>[path,{data:readFileSync(new URL('./desktop-ui/'+file,import.meta.url)),type}]));
 await desktop.initialize();
 const entry='/'+randomUUID()+'/';
 let base;
 const csp="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
 const server=createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',csp);
  res.setHeader('x-content-type-options','nosniff');
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  if(!base||req.headers.host!==new URL(base).host||!req.url?.startsWith(entry)||req.headers['sec-fetch-site']==='cross-site')return json(404,{error:'NOT_FOUND'});
  const path=req.url.slice(entry.length);
  if(req.method==='GET'){
   const asset=assets.get(path);
   if(asset){res.writeHead(200,{'content-type':asset.type+'; charset=utf-8'});return res.end(asset.data);}
   try{
    if(path==='api/state')return json(200,{...desktop.state(),ranges});
    if(path==='api/notes')return json(200,desktop.notes());
   }catch(e){return json(409,{error:e.code??'SERVICE_BUSY'});}
   return json(404,{error:'NOT_FOUND'});
  }
  if(req.method!=='POST'||req.headers.origin!==base||req.headers['content-type']!=='application/json')return json(403,{error:'LOCAL_ORIGIN_REQUIRED'});
  try{
   const parts=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){json(413,{error:'INPUT_TOO_LONG'});return;}parts.push(chunk);}
   const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
   switch(path){
    case 'api/apply':await desktop.apply(body);return json(200,{ok:true});
    case 'api/check-key':return json(200,await desktop.checkKey(body.key));
    case 'api/chat':return json(200,await desktop.say(body.text));
    case 'api/import':return json(200,desktop.import(body.notes));
    case 'api/connect-qq':return json(200,await desktop.connectQQ());
    case 'api/disconnect-qq':await desktop.stopQQ();return json(200,{ok:true});
    default:return json(404,{error:'NOT_FOUND'});
   }
  }catch(e){json(400,{error:typeof e.code==='string'&&/^[A-Z_0-9]+$/.test(e.code)?e.code:'REQUEST_FAILED'});}
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(e){await desktop.stop();throw e;}
 base='http://127.0.0.1:'+server.address().port;
 return {url:base+entry,async stop(){await desktop.stop();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const running=await startDesktop();
 console.log('Threadline 本地工作台：'+running.url);
 console.log('按 Ctrl+C 正常退出。');
 if(process.argv.includes('--open')&&process.platform==='win32'){
  const child=spawn('explorer.exe',[running.url],{stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
 }
 let closing=false;
 const stop=async()=>{if(closing)return;closing=true;try{await running.stop();}catch(e){closing=false;console.error(e.code??'SHUTDOWN_FAILED');}};
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}

