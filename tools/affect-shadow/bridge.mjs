import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const worker=fileURLToPath(new URL('./worker.py',import.meta.url));
export const python=process.env.JY_AFFECT_PYTHON??join(root,'_local/affect-runtime/python-3.13.9/python.exe');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const check=(ok,code)=>{if(!ok)fail(code);};
export function callWorker(input,{executable=python,script=worker,timeoutMs=20000,signal}={}){
 return new Promise((resolveResult,reject)=>{
  const child=spawn(executable,['-B',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'},signal});
  let output='',error='',settled=false;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const finish=(e,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(e)reject(e);else resolveResult(result);};
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('worker timeout'),{code:'WORKER_TIMEOUT'}));},timeoutMs);
  child.on('error',e=>finish(Object.assign(new Error('worker unavailable'),{code:'WORKER_UNAVAILABLE',cause:e})));
  child.stdout.on('data',b=>{output+=b.toString('utf8');if(Buffer.byteLength(output)>8*1024*1024){child.kill();finish(Object.assign(new Error('worker output limit'),{code:'WORKER_OUTPUT_LIMIT'}));}});
  child.stderr.on('data',b=>{if(error.length<4096)error+=b.toString('utf8');});
  child.on('close',code=>{if(settled)return;try{check(code===0,'WORKER_EXIT');const lines=output.trim().split(/\r?\n/);check(lines.length===1,'WORKER_PROTOCOL');const value=JSON.parse(lines[0]);check(typeof value.ok==='boolean','WORKER_PROTOCOL');if(!value.ok)fail(value.error??'WORKER_REJECTED');check(value.result?.state?.format==='jingyang-affect-shadow-v1','WORKER_PROTOCOL');finish(null,value.result);}catch(e){finish(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input)+'\n');
 });
}

// A separate synthetic shadow archive, never a ContinuityStore or production migration.
// Immutable commits are the truth. No mutable pointer can hide a committed result.
export class ShadowArchive {
 constructor(directory,{invoke=callWorker}={}){this.directory=resolve(directory);this.invoke=invoke;mkdirSync(this.directory,{recursive:true});}
 read(){
  check(!existsSync(join(this.directory,'.pending')),'SHADOW_RECOVERY_REQUIRED');
  const files=readdirSync(this.directory).filter(f=>/^\d{6}\.json$/.test(f)).sort();let last=null;
  for(let i=0;i<files.length;i++){
   check(files[i]===String(i).padStart(6,'0')+'.json','SHADOW_CHAIN');const commit=JSON.parse(readFileSync(join(this.directory,files[i])));
   check(commit.seq===i&&commit.previousHash===(last?.hash??null)&&hash(commit.payload)===commit.hash,'SHADOW_CHAIN');last=commit;
  }
  return last;
 }
 #publish(payload,prior,{beforePublish}={}){
  const lock=join(this.directory,'.lock');let fd;
  try{fd=openSync(lock,'wx');}catch{fail('SHADOW_LOCKED');}
  try{
   const actual=this.read();check((actual?.hash??null)===(prior?.hash??null),'STALE_SHADOW');
   const seq=(prior?.seq??-1)+1,commit={seq,previousHash:prior?.hash??null,hash:hash(payload),payload};
   const pending=join(this.directory,'.pending');const file=openSync(pending,'wx');try{writeFileSync(file,JSON.stringify(commit)+'\n');fsyncSync(file);}finally{closeSync(file);}
   beforePublish?.();renameSync(pending,join(this.directory,String(seq).padStart(6,'0')+'.json'));return commit;
  }finally{if(fd!==undefined){closeSync(fd);unlinkSync(lock);}}
 }
 async initialize(nowMs,config){check(!this.read(),'SHADOW_EXISTS');const result=await this.invoke({action:'initialize',nowMs,config});return this.#publish({kind:'initialize',result},null);}
 async apply(operation,options={}){
  const prior=this.read();check(prior,'SHADOW_MISSING');const result=await this.invoke({action:'transition',state:prior.payload.result.state,operation});
  if(result.receipt.duplicate)return {duplicate:true,commit:prior,result};
  check(result.state.revision===prior.payload.result.state.revision+1&&result.receipt.operationId===operation.id,'WORKER_BINDING');
  const commit=this.#publish({kind:'transition',operation,result},prior,options);return {duplicate:false,commit,result};
 }
}
