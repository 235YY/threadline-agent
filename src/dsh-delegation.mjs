import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {redactSensitiveEgress} from './security-guard.mjs';

const reject=(code)=>{throw Object.assign(Error(code),{code,transportInvoked:false});};
const safePart=s=>s.length>0&&!s.startsWith('.')&&!/[<>:"|?*\x00-\x1f]/u.test(s)&&!/[. ]$/u.test(s)&&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)&&
  !/^(?:credentials?|secrets?|tokens?|passwords?)(?:\.|$)|\.(?:dpapi|pem|key|sqlite3?|db|exe|cmd|bat|com|msi|dll)$/i.test(s);
const privateText=value=>redactSensitiveEgress(value).redacted||
  /(?:-----BEGIN|(?:api[_ -]?key|authorization|cookie|token|password|密码|密钥|凭据)\s*[:=：])/iu.test(value);

export function authorizedDshWorkspace(runner,officeDir){
  // Only a host-supplied isolated runner, bound to this resident's desk.
  if(typeof runner?.run!=='function'||typeof runner.workspaceRoot!=='string'||!isAbsolute(runner.workspaceRoot))return null;
  try{
    const root=realpathSync(officeDir);
    return root===resolve(runner.workspaceRoot)&&root===realpathSync(runner.workspaceRoot)&&statSync(root).isDirectory()?root:null;
  }catch{return null;}
}

function deliveryFile(root,value,includeText=false){
  if(typeof value!=='string'||value.length>240||value.includes('\\'))throw Error('DSH_ARTIFACT_PATH');
  const parts=value.split('/');
  if(!parts.every(safePart))throw Error('DSH_ARTIFACT_PATH');
  let path=root;
  for(const part of parts){
    path=resolve(path,part);
    if(lstatSync(path).isSymbolicLink())throw Error('DSH_ARTIFACT_PATH');
  }
  const physical=realpathSync(path),rel=relative(root,physical);
  const st=statSync(physical);
  if(rel=== '..'||rel.startsWith('..'+sep)||isAbsolute(rel)||physical!==path||!st.isFile()||
    st.size>2*1024*1024||st.nlink!==1)throw Error('DSH_ARTIFACT_PATH');
  const data=readFileSync(physical);
  if(data.length>2*1024*1024||data.includes(0)||privateText(data.toString('utf8')))throw Error('DSH_ARTIFACT_PRIVATE');
  return {path:value,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),...(includeText?{text:data.toString('utf8')}:{})};
}

export function readDshArtifact(root,path,sha256){
  try{
    const result=deliveryFile(realpathSync(root),path,true);
    if(result.sha256===sha256)return result;
  }catch{}
  reject('DSH_ARTIFACT_CHANGED');
}

export async function delegateDsh({runner,officeDir,requestId,body,timeoutMs=90_000}){
  const root=authorizedDshWorkspace(runner,officeDir);
  if(!root)reject('DSH_WORKSPACE_NOT_GRANTED');
  if(typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>12_000||body.includes('[附件 ')||privateText(body))
    reject('DSH_INPUT_NOT_SHAREABLE');
  const start=Date.now(),controller=new AbortController();
  let timer;
  try{
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
      controller.abort();reject(Error('DSH_DEADLINE'));
    },timeoutMs);});
    const result=await Promise.race([Promise.resolve().then(()=>runner.run({
      requestId,workspaceRoot:root,brief:body,signal:controller.signal,
    })),deadline]);
    if(result?.outcome!=='succeeded'||typeof result.summary!=='string'||!result.summary.trim()||
      !Array.isArray(result.files)||result.files.length>8||new Set(result.files).size!==result.files.length||
      authorizedDshWorkspace(runner,officeDir)!==root)throw Error('DSH_RESULT');
    const files=result.files.map(path=>deliveryFile(root,path));
    const summary=[...result.summary.trim()].slice(0,320).join('');
    if(privateText(summary))throw Error('DSH_RESULT_PRIVATE');
    return {outcome:'succeeded',summary,files,durationMs:Math.max(0,Date.now()-start)};
  }catch{
    throw Object.assign(Error(JSON.stringify({outcome:'unknown',error:'DSH_OUTCOME_UNKNOWN',
      durationMs:Math.max(0,Date.now()-start),automaticRetry:false})),{code:'DSH_OUTCOME_UNKNOWN'});
  }finally{clearTimeout(timer);}
}

