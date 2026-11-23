// Isolated append-only research evidence; no model client, subject database or credentials.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export class EvidenceRun {
  constructor({base,label='review'}){
    if(!/^[a-z0-9-]{1,64}$/i.test(label))throw Error('unsafe run label');
    this.runId=label+'-'+randomUUID();this.root=join(resolve(base),this.runId);
    mkdirSync(resolve(base),{recursive:true});mkdirSync(this.root);this.files=[];this.closed=false;
    this.write('STARTED.json',{runId:this.runId,at:new Date().toISOString()});
  }
  write(name,value){
    if(this.closed)throw Error('evidence run sealed');
    const path=resolve(this.root,name),rel=relative(this.root,path);
    if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel)||rel==='MANIFEST.json')throw Error('unsafe evidence path');
    const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
    writeFileSync(path,bytes,{flag:'wx'});
    this.files.push({file:rel,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  seal(outcome){
    if(this.closed)throw Error('evidence run already sealed');
    for(const entry of this.files){const actual=createHash('sha256').update(readFileSync(join(this.root,entry.file))).digest('hex');if(actual!==entry.sha256)throw Error('evidence changed before seal');}
    writeFileSync(join(this.root,'MANIFEST.json'),JSON.stringify({runId:this.runId,outcome,files:this.files},null,2)+'\n',{flag:'wx'});this.closed=true;
  }
}
export function testEvidence(label){
  const archive=new EvidenceRun({base:process.env.RC_TEST_EVIDENCE_ROOT??'_local/acceptance/regression-runs',label});
  process.once('exit',code=>{if(!archive.closed)try{archive.seal({status:'test-process-exited',exitCode:code});}catch(error){process.stderr.write('Evidence sealing failed: '+error.message+'\n');process.exitCode=1;}});
  return archive;
}
export async function guardedBatch({items,execute,archive}){
  const outcomes=[];
  for(let index=0;index<items.length;index++){
    let result;try{result=await execute(items[index],index);}catch(error){result={ok:false,error:{code:error.code??error.name,message:error.message}};}
    archive.write('item-'+String(index+1).padStart(3,'0')+'.json',result);
    outcomes.push(result);
    if(!result||result.ok===false||result.complete===false||result.error){archive.seal({status:'stopped',index,remaining:items.length-index-1});return {stopped:true,outcomes};}
  }
  archive.seal({status:'completed',count:outcomes.length});return {stopped:false,outcomes};
}
