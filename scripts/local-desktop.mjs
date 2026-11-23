
import {mkdirSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {launchBrain} from '../tools/brain-service/bootstrap.mjs';
import {createModelDecision} from '../src/model-transport.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {officialDay} from '../src/official-dashboard.mjs';
import {writeLedgerAtomically} from '../src/ledger-io.mjs';
import {callWorker} from '../tools/affect-shadow/bridge.mjs';
import {readAccount} from '../tools/qq-connect/account.mjs';
import {digest,ensure} from '../src/contracts.mjs';

const must=(ok,code)=>ensure(ok,code,code);
export const ranges={reactivity:[0,3],social_need:[0,.2],novelty_need:[0,.2],competence_need:[0,.2],recognition_need:[0,.2],
 fatigue_recovery_h:[.25,48],mood_tau_h:[.1,48],baseline_tau_d:[1,90],resilience_tau_d:[1,180],circadian_strength:[0,1]};
const kinds=['fact_claim','interpretation','value','preference','dream','tension','feeling','skill'];
const keyPattern=/^sk-[A-Za-z0-9_-]{12,200}$/;
const accountPattern=/^\d{5,15}$/;
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const txt=(value,max,code)=>{must(typeof value==='string'&&value.length<=max&&!value.includes('\0'),code);return value.trim();};
export function cleanProfile(value){
 must(plain(value),'PROFILE_FORMAT');
 const {identity,style='',live=false,daily=5,affect=false,fusion=false,python='',parameters={},timezoneMinutes=480,qq={}}=value;
 must([live,affect,fusion].every(v=>typeof v==='boolean')&&(!fusion||affect),'PROFILE_FLAGS');
 must(Number.isFinite(daily)&&daily>=.1&&daily<=20,'BUDGET_RANGE');
 must(Number.isSafeInteger(timezoneMinutes)&&timezoneMinutes>=-720&&timezoneMinutes<=840,'TIMEZONE_RANGE');
 must(plain(parameters)&&Object.entries(parameters).every(([k,v])=>Object.hasOwn(ranges,k)&&Number.isFinite(v)&&v>=ranges[k][0]&&v<=ranges[k][1]),'LIMBIC_PARAMETERS');
 const body=txt(identity,4000,'IDENTITY_SIZE');must(body.length,'IDENTITY_REQUIRED');
 const result={identity:body,style:txt(style,16000,'STYLE_SIZE'),live,daily,affect,fusion,python:txt(python,1000,'PYTHON_PATH'),timezoneMinutes,parameters,qq:{}};
 must(plain(qq),'QQ_CONFIG');
 for(const k of ['bot','owner','home','sdk'])result.qq[k]=txt(qq[k]??'',1000,'QQ_CONFIG');
 for(const k of ['bot','owner'])must(!result.qq[k]||accountPattern.test(result.qq[k]),'QQ_ACCOUNT');
 for(const k of ['home','sdk'])must(!result.qq[k]||isAbsolute(result.qq[k]),'QQ_PATH');
 return result;
}

// This desktop mode uses local estimates, not provider billing. Reserve the
// full quoted amount for pending/unknown requests, checked synchronously at reserve.
export class DesktopJournal extends RequestJournal{
 constructor(file,limit,clock=Date.now){super(file);this.limit=limit;this.clock=clock;}
 usage(){
  const day=officialDay(this.clock());
  const sum=this.data.requests.filter(r=>officialDay(r.recordedAt)===day)
   .reduce((n,r)=>n+(r.status==='settled'?(r.actualMicros??Infinity):['reserved','dispatched','uncertain'].includes(r.status)?(r.desktopQuote??Infinity):0),0);
  return {allow:sum<this.limit,known:true,estimate:Number.isFinite(sum)?sum/1e6:null};
 }
 reserve(id,fingerprint,quote,context){
  must(Number.isSafeInteger(quote)&&quote>=0,'BUDGET_QUOTE');
  // Same journal write as the durable reservation. Don't permit an unquoted
  // send after a disk failure; the client must dispatch after this succeeds.
  const usage=this.usage();
  must(usage.estimate!==null&&Math.round(usage.estimate*1e6)+quote<=this.limit,'DESKTOP_BUDGET_LIMIT');
  this.quote=quote;this.quoteId=id;
  try{return super.reserve(id,fingerprint,quote,context);}finally{this.quote=null;this.quoteId=null;}
 }
 save(){
  if(this.quote!=null){
   const r=this.data.requests.find(row=>row.id===this.quoteId&&row.status==='reserved');
   if(r)r.desktopQuote=Math.max(this.quote,r.desktopQuote??0);
  }
  super.save();
 }
}

export function importNotes(store,input){
 const items=Array.isArray(input)?input:input?.format==='threadline-notes-v1'?input.notes:null;
 must(Array.isArray(items)&&items.length>=1&&items.length<=128,'MEMORY_COUNT');
 const commands=[];
 for(const item of items){
  const row=typeof item==='string'?{body:item}:item;
  must(plain(row),'MEMORY_FORMAT');
  const body=txt(row.body,4000,'MEMORY_SIZE');must(body.length,'MEMORY_EMPTY');
  const kind=row.kind??'interpretation';must(kinds.includes(kind),'MEMORY_KIND');
  const id='note:import:'+digest({body,kind});
  if(commands.some(c=>c.id===id)||store.read(id))continue;
  commands.push({op:'write_note',id,expectedRevision:0,kind,body,change:'self_report',confidence:'tentative',evidence:[]});
 }
 if(commands.length)store.execute({requestId:'desktop-import:'+digest(commands),commands});
 return {imported:commands.length,duplicates:items.length-commands.length};
}

const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function createDesktop({root,directory=join(root,'_local/desktop'),makeModel=createModelDecision,providerFetch=fetch}={}){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const configFile=join(directory,'settings.json'),initial=readFileSync(join(root,'config/identity.example.txt'),'utf8').trim();
 let profile=cleanProfile(existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{identity:initial});
 let runtime=null,secret='',journal=null,connector=null,active=false,qqStatus='off';
 const token=randomUUID(),controlToken=randomUUID(),control=join(directory,'qq-control-'+randomUUID()+'.json');
 const gate={gate:()=>journal.usage()};
 const connectorReady=()=>qqStatus==='connected';
 let chatting=false;
 async function stopQQ(){
  if(!connector)return;
  const child=connector;qqStatus='stopping';
  if(!child.pid){connector=null;qqStatus='off';return;}
  writeFileSync(control,JSON.stringify({command:'stop',pid:child.pid,token:controlToken}),{mode:0o600});
  for(let i=0;connector===child&&i<24;i++)await pause(250);
  must(connector!==child,'QQ_STOP_PENDING');
 }
 async function stop(){
  await stopQQ();
  if(runtime){await runtime.stop();runtime=null;} journal=null;
 }
 async function activate(next=profile,key=secret){
  must(!active&&!chatting&&!runtime?.service.health().cognitionBusy,'SERVICE_BUSY');
  must(!next.live||keyPattern.test(key),'API_KEY_REQUIRED');
  if(next.affect)must(next.python||existsSync(join(root,'_local/affect-runtime/python-3.13.9/python.exe')),'PYTHON_REQUIRED');
  active=true;
  const previous=profile,previousSecret=secret;
  try{
   if(runtime&&next.affect){
    const store=runtime.service.store,subject=store.read('jingyang'),r=subject?.motivationState?store.read(subject.motivationState.id,subject.motivationState.revision):null;
    must(!r||r.snapshot.config.timezoneMinutes===next.timezoneMinutes&&digest(r.snapshot.config.parameters)===digest(next.parameters),'LIMBIC_PROFILE_LOCKED');
   }
   await stop();
   const start=async(p,k)=>{
    const identityFile=join(directory,'identity.txt'),styleDirectory=join(directory,'styles');
    writeFileSync(identityFile,p.identity,{mode:0o600});
    const stylePath=join(styleDirectory,'packs','desktop.md'),index=join(styleDirectory,'index.json');
    mkdirSync(join(styleDirectory,'packs'),{recursive:true});
    if(p.style)writeFileSync(stylePath,p.style,{mode:0o600});
    else rmSync(stylePath,{force:true});
    writeFileSync(index,JSON.stringify({version:1,active:p.style?'desktop':null,items:p.style?[{id:'desktop',label:'我的语言包',source:'local-setup',createdAt:0}]:[]}),{mode:0o600});
    const env={
     BRAIN_LIVE:p.live?'1':'0',BRAIN_PORT:'0',BRAIN_GLOBAL:'1',BRAIN_TOKEN:token,BRAIN_HEARTBEAT_MS:'0',
     BRAIN_STORE:join(directory,'subject.sqlite'),BRAIN_STATE:join(directory,'state'),BRAIN_STYLE_DIR:styleDirectory,
     BRAIN_IDENTITY_FILE:identityFile,BRAIN_LEDGER:join(directory,'requests.json'),BRAIN_MAINTENANCE:'0',BRAIN_MAX_TOKENS:'2000',BRAIN_REASONING:'off',
     JY_LIVE_CONFIRM:'YES',JY_NEW_SUBJECT:'1',JY_NEW_REQUEST_JOURNAL:'1',JY_QQ_SCOPE:'all',
     JY_INTENT_PROTOCOL:'1',JY_APPERCEPTION_V1:'1',JY_SUBJECTIVE_MEMORY_V2:'1',JY_SUBJECTIVE_DOMAINS:'1',JY_TASK_THREADS:'1',
     JY_REQUIRE_BRAIN_TOKEN:'1',JY_GROUP_INGEST:'off',
     JY_AFFECT:p.affect?'1':'0',JY_AFFECT_FUSION:p.fusion?'1':'0',...(p.python?{JY_AFFECT_PYTHON:p.python}:{}),
     ...(p.qq.owner?{QQ_OWNER:p.qq.owner,QQ_TEST_ONLY_OWNER:p.qq.owner}:{}),
    };
    if(p.live)journal=new DesktopJournal(env.BRAIN_LEDGER,Math.round(p.daily*1e6));
    const qqTools=()=>{
     const call=async(name,args,context)=>{
      if(name!=='qq_send_message'||!connectorReady()||args.target!=='private'||String(args.id)!==p.qq.owner)
       return {delivered:false,reason:'QQ_NOT_CONNECTED_OR_OUT_OF_SCOPE'};
      const a=readAccount({home:p.qq.home,uin:p.qq.bot});
      const response=await fetch(a.httpUrl+'/send_private_msg',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
       headers:{'content-type':'application/json',...(a.http.accessToken?{authorization:'Bearer '+a.http.accessToken}:{})},
       body:JSON.stringify({user_id:args.id,message:[{type:'text',data:{text:args.text}}]})});
      const body=await response.json();
      if(!response.ok||body?.status!=='ok'||body.retcode!==0||body.data?.message_id==null)throw Error('QQ_SEND_OUTCOME_UNKNOWN');
      return {delivered:true,message_id:String(body.data.message_id)};
     };
     return {TOOL_NAMES:[],UNAVAILABLE_TOOLS:[],executeTool:call};
    };
    try{
     runtime=await launchBrain({root,env,dependencies:{
      ...(p.live?{requestJournal:journal,officialSpend:gate,createModelDecision:o=>makeModel({...o,officialSpend:null,getKey:()=>k}),tools:qqTools(),nativeActions:['remember_note']}:{}),
      ...(p.affect?{affectOptions:{config:{timezoneMinutes:p.timezoneMinutes,parameters:p.parameters},
       ...(p.python?{worker:(input,options)=>callWorker(input,{...options,executable:p.python})}:{})}}:{}),
     }});
    }catch(e){journal?.close();journal=null;throw e;}
   };
   try{await start(next,key);}
   catch(e){if(runtime)await stop();if(next!==previous){await start(previous,previousSecret).catch(()=>{});}throw e;}
   try{if(next!==previous)writeLedgerAtomically(configFile,next);}
   catch(e){await stop();await start(previous,previousSecret).catch(()=>{});throw e;}
   profile=next;secret=key;
  }finally{active=false;}
 }
 async function initialize(){
  // A saved profile may have live=true; a new process always needs fresh key consent.
  await activate(profile.live?{...profile,live:false}:profile,'');
 }
 async function apply(input){
  const next=cleanProfile(input.profile),key=input.key===undefined||input.key===''?secret:txt(input.key,240,'API_KEY_FORMAT');
  must(!input.key||keyPattern.test(key),'API_KEY_FORMAT');
  return activate(next,key);
 }
 async function checkKey(key){
  const use=key?txt(key,240,'API_KEY_FORMAT'):secret;
  must(keyPattern.test(use),'API_KEY_FORMAT');
  const response=await providerFetch('https://api.deepseek.com/user/balance',{redirect:'error',headers:{authorization:'Bearer '+use},signal:AbortSignal.timeout(8000)});
  await response.body?.cancel();
  must(response.ok,response.status===401?'API_KEY_REJECTED':'API_CHECK_UNAVAILABLE');
  return {ok:true};
 }
 async function connectQQ(){
  must(!active&&!connector&&runtime&&profile.live,'QQ_NOT_READY');
  must(journal.usage().allow,'DESKTOP_BUDGET_LIMIT');
  const {home,sdk,bot,owner}=profile.qq;
  must(home&&sdk&&bot&&owner&&existsSync(sdk),'QQ_SETUP_REQUIRED');
  try{readAccount({home,uin:bot});}catch{must(false,'QQ_ONEBOT_CONFIG');}
  qqStatus='connecting';
  const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|USERPROFILE|HOME|APPDATA|COMSPEC)$/i.test(k)));
  const child=fork(join(root,'tools/qq-connect/bridge.mjs'),[],{cwd:root,execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...safeEnv,
   BRAIN_URL:runtime.service.url,BRAIN_TOKEN:token,BRAIN_STATE:join(directory,'state'),
   QQ_UIN:bot,QQ_OWNER:owner,QQ_TEST_ONLY_OWNER:owner,QQ_CHAT_SCOPE:'owner-test',SNOWLUMA_HOME:home,QQ_SDK_MODULE:pathToFileURL(sdk).href,
   QQ_CONNECTOR_LOCK_ROOT:join(home,'.threadline-connectors'),JY_REQUIRE_BRAIN_TOKEN:'1',JY_CONTROL_FILE:control,JY_CONTROL_TOKEN:controlToken}});
  connector=child;
  child.on('disconnect',()=>{if(connector===child&&qqStatus==='connected')qqStatus='failed';});
  child.on('message',m=>{if(connector===child&&m?.type==='unready'&&qqStatus==='connected')qqStatus='reconnecting';});
  child.on('message',m=>{if(connector===child&&m?.type==='ready'&&['connecting','reconnecting'].includes(qqStatus))qqStatus='connected';});
  child.once('error',()=>{if(connector===child){connector=null;qqStatus='failed';}});
  child.once('exit',()=>{if(connector===child){connector=null;qqStatus=qqStatus==='stopping'?'off':'failed';}rmSync(control,{force:true});});
  return {status:qqStatus};
 }
 return {initialize,apply,stop,checkKey,connectQQ,stopQQ,
  state:()=>({profile,hasKey:!!secret,qqStatus,affect:runtime?.service.health().theory??null,limit:journal?.usage()??null}),
  async say(text){
   must(runtime&&!active&&!chatting&&!runtime.service.health().cognitionBusy,'SERVICE_BUSY');
   const body=txt(text,1000,'CHAT_SIZE');must(body.length,'CHAT_SIZE');
   if(journal)must(journal.usage().allow,'DESKTOP_BUDGET_LIMIT');
   chatting=true;
   try{
    const r=await runtime.service.reply({scene:'local/chat',key:'desktop',source:'local-desktop',text:body,message_id:randomUUID(),execute:true});
    if(!r.ok||r.busy||r.deferred||r.budgetPaused)must(false,r.error??'SERVICE_BUSY');
    return {text:r.scene==='local/chat'&&r.outbox?.some(x=>x.kind==='respond'&&runtime.service.store.read(x.response?.id??'missing')?.scene==='local/chat')?r.text:'',live:profile.live,silent:r.silent};
   }finally{chatting=false;}
  },
  import(input){must(runtime&&!active&&!runtime.service.health().cognitionBusy,'SERVICE_BUSY');return importNotes(runtime.service.store,input);},
  notes(){must(runtime&&!active,'SERVICE_BUSY');return {format:'threadline-notes-v1',notes:[...runtime.service.store.all('note')].filter(n=>!n.id.startsWith('rhythm:')&&n.status==='current').map(n=>({body:n.body,kind:n.kind}))};},
 };
}

