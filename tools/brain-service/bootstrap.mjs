import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from '../../src/contracts.mjs';
import {resolveBrainConfig,launchIdentity,assertSupportedNode} from './runtime-config.mjs';
import {claimBrainInstance,runtimeSourceIdentity} from './instance-guard.mjs';
import {withTypedStateContract} from './typed-state-contract.mjs';

// Configuration and authorization precede resource acquisition. No key is loaded here.
export async function launchBrain({root=process.cwd(),env=process.env,dependencies={}}={}){
 assertSupportedNode();
 const config=resolveBrainConfig({root,env});
 ensure(dependencies.core||existsSync(join(config.root,'src/store.mjs'))&&existsSync(join(config.root,'package.json')),'PROJECT_ROOT','launch from the actual project directory');
 if(config.live){
  const auditFn=dependencies.auditBudgets??(await import('../ops/budget-audit.mjs')).auditBudgets;
  const audit=auditFn(config.budgetDirectory);
  ensure(audit.within===true&&audit.unknownCalls===0&&(audit.conflictCount??0)===0,'BUDGET_AUDIT','live budget audit has not established authorization and confirmed costs');
 }
 const guard=claimBrainInstance({stateDirectory:config.stateDirectory});
 const shutdownToken=randomUUID();
 let model=null,service=null,maintenanceHeartbeat=null,stopping=null,drainRetry=null;
 async function stop(){
  if(stopping)return stopping;
  stopping=(async()=>{
   maintenanceHeartbeat?.stop();service?.beginShutdown?.();service?.stopScheduling?.();
   const deadline=Date.now()+(dependencies.shutdownWaitMs??3000);
   while(service?.health?.().cognitionBusy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
   ensure(!service?.health?.().cognitionBusy,'SHUTDOWN_BUSY','in-flight cognitive work remains; preserve ownership, retry after it finishes');
   if(service?.server?.listening)await new Promise((resolve,reject)=>service.server.close(error=>error?reject(error):resolve()));
   if(drainRetry){clearTimeout(drainRetry);drainRetry=null;}service?.close();model?.close();guard.close();
  })().catch(error=>{stopping=null;if(error.code==='SHUTDOWN_BUSY'&&!drainRetry){drainRetry=setTimeout(()=>{drainRetry=null;stop().then(()=>dependencies.onStopped?.()).catch(()=>{});},500);drainRetry.unref();}throw error;});
  return stopping;
 }
 try{
  const {identity,configFingerprint:effectiveFingerprint}=launchIdentity(config,{explicit:env.BRAIN_IDENTITY_FILE!==undefined});
  const build=runtimeSourceIdentity(config.root);
  const core=dependencies.core??await import('./server.mjs');
  let decide,sessionFactory=null,affectAdapter=null;
  if(config.affect.enabled){affectAdapter=dependencies.affect??await import('../affect-integrated/session.mjs');await affectAdapter.probeAffect();sessionFactory=affectAdapter.affectFactory({fusion:config.affect.fusion});}
  if(config.live){
   const makeModel=dependencies.createModelDecision??(await import('../../src/model-transport.mjs')).createModelDecision;
   model=makeModel({ledgerPath:config.ledgerPath,blobDirectory:join(config.stateDirectory,'blobs'),profile:{...config.profile,formatRecovery:true}});decide=model.decide;
  }
  let registeredToolNames=[],agentTools={},adapter={send:async()=>({delivered:false,mode:'dry-run'}),act:async()=>{ensure(false,'DRY_RUN_TOOL_DISABLED','dry-run cannot execute external tools');}};
  if(config.live){
   const tools=dependencies.tools??await import('../qq-connect/tools.mjs');
   registeredToolNames=[...tools.TOOL_NAMES];
   decide.operationPolicy={registeredToolNames:tools.TOOL_NAMES,dependencyStatus:'not-confirmed',...(env.QQ_TEST_ONLY_OWNER?{externalSend:{target:'private',recipient:String(env.QQ_TEST_ONLY_OWNER),meaning:'仅此已授权私聊；通用Schema不授予群发送权限'}}:{})};
   // Explicit grants; advertised adapter names are not authority.
   const grants=[...core.READ_ONLY_HOST_TOOLS,'qq_send_sticker'];
   decide.operationPolicy.taskAllowedTools=grants.filter(name=>tools.TOOL_NAMES.includes(name));
   agentTools=Object.fromEntries(grants.filter(name=>tools.TOOL_NAMES.includes(name)).map(name=>[name,args=>tools.executeTool(name,args)]));
   adapter={act:({tool,args})=>tools.executeTool(tool,args),send:async({scene,text})=>{
    if(scene?.startsWith('qq/private/'))return tools.executeTool('qq_send_message',{target:'private',id:scene.slice('qq/private/'.length),text});
    if(scene?.startsWith('qq/group/'))return tools.executeTool('qq_send_message',{target:'group',id:scene.slice('qq/group/'.length),text});
    return {delivered:false,scene};
   }};
  }
  if(sessionFactory)sessionFactory=withTypedStateContract(sessionFactory);
  const runtimeInfo={mode:config.mode,configFingerprint:effectiveFingerprint,buildFingerprint:build.fingerprint,ledgerPath:config.ledgerPath,cognition:config.cognition,affect:config.affect};
  const nativeActions=['remember_note','start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task'];
  const allowed=config.live?[...core.READ_ONLY_HOST_TOOLS,'qq_send_sticker',...nativeActions].filter(name=>nativeActions.includes(name)||registeredToolNames.includes(name)):[];
  service=await core.startBrainService({port:config.port,token:env.BRAIN_TOKEN??null,storePath:config.storePath,stateDirectory:config.stateDirectory,styleDirectory:config.styleDirectory,
   heartbeatMs:0,decide,identity,rhythm:config.rhythm,cognition:config.cognition,runtimeInfo,shutdownControl:{token:shutdownToken,stop:async()=>{await stop();dependencies.onStopped?.();}},global:config.global,subjectTask:true,idleIntervalMs:config.idleIntervalMs,rhythmReset:config.rhythmReset,
   sessionFactory,theoryStatus:()=>config.affect.enabled?{enabled:true,available:true,version:'limbic-v1',fusion:config.affect.fusion}:{enabled:false,available:false,version:null},
   capabilities:['remember','open','relate','say','do','wait',...allowed],
   agentTools,hostAllowedTools:config.live?[...core.READ_ONLY_HOST_TOOLS,'qq_send_sticker']:[],allowedActionTools:allowed,adapter});
  if(affectAdapter)affectAdapter.verifyStoredAffect({store:service.store,subjectId:'jingyang'});
  ensure(runtimeSourceIdentity(config.root).fingerprint===build.fingerprint,'SOURCE_CHANGED_DURING_BOOT','startup inventory changed; no ready instance published');
  const instance=guard.publish({format:'jingyang-brain-instance-v1',status:'ready',mode:config.mode,affect:config.affect.enabled,fusion:config.affect.fusion,
   startedAt:new Date().toISOString(),shutdownToken,storePath:config.storePath,ledgerPath:config.ledgerPath,stateDirectory:config.stateDirectory,global:config.global,
   configFingerprint:effectiveFingerprint,build,cognition:config.cognition,port:service.port,url:service.url});
  if(config.maintenance){
   const maintenance=dependencies.maintenance??await import('../../src/maintenance.mjs');
   const session=new maintenance.MaintenanceSession({store:service.store,subjectId:'jingyang',identity});
   maintenanceHeartbeat=maintenance.startMaintenanceHeartbeat({session,isBusy:()=>{const h=service.health();return h.cognitionBusy===true||h.active!==null||(h.pending?.length??0)>0;},
    runExclusive:fn=>service.runCognitionExclusive(fn),invoke:model.invokeMaintenance,authorize:async()=>true,
    onResult:r=>console.error('[maintenance]',r.status??'unknown'),onError:e=>console.error('[maintenance]',e.code??'MAINTENANCE_ERROR')});
  }
  service.startScheduling(config.heartbeatMs);
  return {service,instance,config,stop,summary:{url:service.url,port:service.port,mode:config.mode,affect:config.affect.enabled,fusion:config.affect.fusion,
   storePath:config.storePath,stateDirectory:config.stateDirectory,heartbeatMs:config.heartbeatMs,identityFile:config.identityFile,identityChars:identity.length,
   maintenance:!!maintenanceHeartbeat,configFingerprint:effectiveFingerprint,buildFingerprint:build.fingerprint}};
 }catch(error){
  try{await stop();}catch(cleanupError){error.cleanupError=cleanupError.code??'BOOT_CLEANUP_FAILED';}
  throw error;
 }
}
