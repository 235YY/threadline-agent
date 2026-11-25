import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDesktop,ranges} from './local-desktop.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function openDesktopAppWindow(url){
 // Launch as a standalone chromeless desktop app window (no address bar, own taskbar icon!)
 if(process.platform==='win32'){
  const edgeCandidates=[
   process.env['ProgramFiles(x86)']&&`${process.env['ProgramFiles(x86)']}\Microsoft\Edge\Application\msedge.exe`,
   process.env.ProgramFiles&&`${process.env.ProgramFiles}\Microsoft\Edge\Application\msedge.exe`,
   process.env.ProgramFiles&&`${process.env.ProgramFiles}\Google\Chrome\Application\chrome.exe`,
  ].filter(Boolean);
  for(const bin of edgeCandidates){
   if(existsSync(bin)){
    const child=spawn(bin,[`--app=${url}`,'--window-size=1280,840'],{stdio:'ignore',windowsHide:false,detached:true});
    child.on('error',()=>{});child.unref();return;
   }
  }
  const child=spawn('explorer.exe',[url],{stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();return;
 }
 const [cmd,args]=process.platform==='darwin'?['open',['-a','Google Chrome','--args',`--app=${url}`]]:['xdg-open',[url]];
 const child=spawn(cmd,args,{stdio:'ignore',windowsHide:true});
 child.on('error',()=>{if(process.platform==='darwin')spawn('open',[url],{stdio:'ignore'}).unref();});
 child.unref();
}

export async function startDesktop({desktop=createDesktop({root})}={}){
 const assets=new Map([['','index.html','text/html'],['style.css','style.css','text/css'],['app.js','app.js','application/javascript'],['icon.png','icon.png','image/png'],['icon.ico','favicon.ico','image/x-icon'],['favicon.ico','favicon.ico','image/x-icon'],['whale-avatar.png','icon.png','image/png'],['whale-mascot.png','whale-mascot.png','image/png']]
  .map(([path,file,type])=>[path,{data:readFileSync(new URL('./desktop-ui/'+file,import.meta.url)),type}]));
 await desktop.initialize();
 const entry='/'+randomUUID()+'/';
 let base;
 // Strict local CSP: allows local data/blob images for DIY avatars, portraits, backgrounds, and pet packs.
 const csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src http://127.0.0.1:* http://localhost:*; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
 const server=createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',csp);
  res.setHeader('x-content-type-options','nosniff');
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  if(!base||req.headers.host!==new URL(base).host||!req.url?.startsWith(entry)||req.headers['sec-fetch-site']==='cross-site')return json(404,{error:'NOT_FOUND'});
  const rawPath=req.url.slice(entry.length);
  const path=rawPath.split('?')[0];
  if(req.method==='GET'){
   if(path==='custom.css'){
    const safeMode=rawPath.includes('safe=1')||process.argv.includes('--safe');
    res.writeHead(200,{'content-type':'text/css; charset=utf-8'});
    return res.end(safeMode?'':(desktop.customCss?.()??''));
   }
   const asset=assets.get(path);
   if(asset){const ct=asset.type.startsWith('image/')?asset.type:asset.type+'; charset=utf-8';res.writeHead(200,{'content-type':ct});return res.end(asset.data);}
   try{
    if(path==='api/state')return json(200,{...desktop.state(),ranges});
    if(path==='api/notes')return json(200,desktop.notes());
    if(path==='api/glassbox')return json(200,desktop.glassbox());
    if(path==='api/components')return json(200,desktop.components());
    if(path==='api/components/job')return json(200,desktop.componentJob());
    if(path==='api/storage')return json(200,desktop.storage());
    if(path==='api/mcp')return json(200,desktop.mcpStatus());
    if(path==='api/gateway')return json(200,desktop.gatewayStatus());
    if(path==='api/update-check')return json(200,await desktop.checkUpdate());
    if(path==='api/roster')return json(200,desktop.rosterState());
    if(path==='api/copilot/protocol')return json(200,desktop.copilotProtocol());
    if(path==='api/create/state')return json(200,{...desktop.createModeState(),safeMode:process.argv.includes('--safe')});
    if(path==='api/community/state')return json(200,desktop.communityState());
    if(path==='api/memory/graph')return json(200,desktop.memoryGraph());
    if(path==='api/skills')return json(200,desktop.listSkills());
    if(path==='api/team/state')return json(200,desktop.teamState());
    if(path==='api/context/epoch')return json(200,desktop.contextEpochState());
    if(path==='api/wire-layout/compare')return json(200,desktop.wireLayoutCompare());
    if(path==='api/sensory/status')return json(200,desktop.sensoryStatus());
    if(path==='api/dream-digest')return json(200,desktop.weeklyDreamDigest());
    if(path==='api/liveness/state')return json(200,desktop.livenessState());
    if(path==='api/memory/import/protocol')return json(200,desktop.memoryImportProtocol());
   }catch(e){return json(409,{error:e.code??'SERVICE_BUSY'});}
   return json(404,{error:'NOT_FOUND'});
  }
  if(req.method!=='POST'||req.headers.origin!==base||req.headers['content-type']!=='application/json')return json(403,{error:'LOCAL_ORIGIN_REQUIRED'});
  try{
   const limit=path==='api/capsule/restore'?(129*1024*1024):(10*1024*1024);
   const parts=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>limit){json(413,{error:'INPUT_TOO_LONG'});return;}parts.push(chunk);}
   const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
   switch(path){
    case 'api/apply':await desktop.apply(body);return json(200,{ok:true});
    case 'api/check-key':return json(200,await desktop.checkKey(body.key,body.baseUrl));
    case 'api/chat':return json(200,await desktop.say(body.text,{attachments:body.attachments}));
    case 'api/import':return json(200,desktop.import(body.notes));
    case 'api/connect-qq':return json(200,await desktop.connectQQ());
    case 'api/disconnect-qq':await desktop.stopQQ();return json(200,{ok:true});
    case 'api/memory/note-save':return json(200,desktop.saveNote(body));
    case 'api/memory/state-propose':return json(200,await desktop.proposeStateEdit(body));
    case 'api/memory/event-retire':return json(200,desktop.retireEvent(body));
    case 'api/memory/note-archive':return json(200,desktop.archiveNote(body));
    case 'api/memory/note-merge':return json(200,desktop.mergeNotes(body));
    case 'api/memory/migrate':return json(200,desktop.migrateMemoryToResident(body));
    case 'api/skills/save':return json(200,desktop.saveSkill(body));
    case 'api/skills/toggle':return json(200,desktop.toggleSkill(body));
    case 'api/skills/delete':return json(200,desktop.deleteSkill(body));
    case 'api/team/toggle':return json(200,desktop.setTeamEnabled(body));
    case 'api/team/message':return json(200,desktop.sendTeamMessage(body));
    case 'api/team/file':return json(200,desktop.saveSharedWorkspaceFile(body));
    case 'api/team/subagent':return json(200,await desktop.runSubAgent(body));
    case 'api/chat/regenerate':return json(200,await desktop.regenerateReply(body));
    case 'api/chat/edit-reply':return json(200,desktop.editReplyRecord(body));
    case 'api/context/compact-half':return json(200,desktop.compactContextHalf());
    case 'api/context/rollover':return json(200,desktop.rolloverContextNightly());
    case 'api/sensory/policy':return json(200,desktop.updateSensoryPolicy(body));
    case 'api/sensory/curtain':return json(200,desktop.setSensoryCurtain(body?.curtain));
    case 'api/sensory/clients/issue':return json(200,desktop.issueSensoryClient(body));
    case 'api/sensory/clients/revoke':return json(200,desktop.revokeSensoryClient(body));
    case 'api/sensory/signal':return json(200,desktop.ingestSensorySignal(body));
    case 'api/capsule/export':return json(200,desktop.exportTimeCapsule(body));
    case 'api/capsule/restore':return json(200,desktop.restoreTimeCapsule(body));
    case 'api/liveness/split':return json(200,desktop.splitNaturalReply(body));
    case 'api/liveness/nudge-check':return json(200,desktop.checkBaselineNudge(body));
    case 'api/memory/import/preview':return json(200,desktop.previewImport(body));
    case 'api/memory/import/commit':return json(200,desktop.commitImport(body));
    case 'api/journal':return json(200,await desktop.writeJournal(body));
    case 'api/office/read':return json(200,desktop.readOfficeFile(body));
    case 'api/autonomy':return json(200,await desktop.stepAutonomy());
    case 'api/reflect':return json(200,await desktop.reflect());
    case 'api/storage/maintain':return json(200,desktop.maintainStorage());
    case 'api/components/install':return json(200,await desktop.installComponents(body));
    case 'api/mcp/apply':return json(200,await desktop.applyMcp(body));
    case 'api/gateway/quick-setup':return json(200,await desktop.quickSetupGateway(body));
    case 'api/residents/create':return json(200,await desktop.createResident(body));
    case 'api/residents/switch':return json(200,await desktop.switchResident(body));
    case 'api/residents/update':return json(200,await desktop.updateResident(body));
    case 'api/providers/save':return json(200,desktop.saveProvider(body));
    case 'api/providers/delete':return json(200,desktop.deleteProvider(body));
    case 'api/providers/copilot':return json(200,desktop.setCopilotProvider(body));
    case 'api/copilot/parse':return json(200,desktop.parseCopilotPatch(body));
    case 'api/copilot/ask':return json(200,await desktop.askCopilot(body));
    case 'api/copilot/approve':return json(200,await desktop.approveCopilotProposal(body));
    case 'api/copilot/reject':return json(200,desktop.rejectCopilotProposal(body));
    case 'api/copilot/search-github':return json(200,await desktop.copilotSearchGithub(body));
    case 'api/create/save':return json(200,desktop.saveExtension(body));
    case 'api/create/toggle':return json(200,desktop.toggleExtension(body));
    case 'api/create/delete':return json(200,desktop.deleteExtension(body));
    case 'api/create/rollback':return json(200,await desktop.rollbackSnapshot(body));
    case 'api/create/factory-reset':return json(200,await desktop.factoryResetShell());
    case 'api/community/channels':return json(200,desktop.saveCommunityChannels(body));
    case 'api/community/export':return json(200,desktop.exportSharePack(body));
    case 'api/community/import-preview':return json(200,desktop.previewSharePackImport(body));
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
 console.log('Threadline Studio（百搭玻璃箱工作台）：'+running.url);
 console.log('按 Ctrl+C 正常退出。');
 if(process.argv.includes('--open')&&process.env.THREADLINE_NO_BROWSER!=='1')openDesktopAppWindow(running.url);
 let closing=false;
 const stop=async()=>{if(closing)return;closing=true;try{await running.stop();}catch(e){closing=false;console.error(e.code??'SHUTDOWN_FAILED');}};
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}
