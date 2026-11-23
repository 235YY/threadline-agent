// Read-only by default. Applying a tool review is an explicit operator action, not a model tool.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {digest,ensure} from '../../src/contracts.mjs';

export async function recovery({stateDirectory,reviewFile=null,evidenceFile=null,turnId=null,keepUnknownReserve=false,apply=false,request=fetch}){
  const instance=JSON.parse(readFileSync(join(resolve(stateDirectory),'brain.instance.json'),'utf8'));
  const headers={'content-type':'application/json','x-jingyang-control':instance.shutdownToken,...(process.env.BRAIN_TOKEN?{'x-brain-token':process.env.BRAIN_TOKEN}:{})};
  if(!apply){const [health,outbox]=await Promise.all([request(instance.url+'/health',{headers}),request(instance.url+'/v1/outbox',{headers})]);ensure(health.ok&&outbox.ok,'RECOVERY_INSPECTION','service inspection failed');return {health:await health.json(),outbox:await outbox.json()};}
  if(turnId){
    const info=await request(instance.url+'/v1/recovery/turn/'+encodeURIComponent(turnId),{headers});ensure(info.ok,'AFFECT_RESOLUTION','cannot inspect turn');const turn=await info.json();
    const bytes=readFileSync(instance.ledgerPath),response=await request(instance.url+'/v1/recovery/close-turn',{method:'POST',headers,body:JSON.stringify({turnId,expectedRevision:turn.revision,ledgerHash:createHash('sha256').update(bytes).digest('hex'),keepUnknownReserve})});
    const result=await response.json();ensure(response.ok&&!result.error,result.error??'AFFECT_RESOLUTION',result.message??'turn closure failed');return result;
  }
  ensure(reviewFile&&evidenceFile,'TOOL_REVIEW','review and original evidence files must both be explicitly named');
  const artifact=JSON.parse(readFileSync(resolve(reviewFile),'utf8')),review=artifact.review;
  const evidence=readFileSync(resolve(evidenceFile));ensure(review?.evidence?.sha256===createHash('sha256').update(evidence).digest('hex'),'TOOL_REVIEW','evidence file hash mismatch');
  const response=await request(instance.url+'/v1/tasks/'+encodeURIComponent(review.taskId)+'/reconcile',{method:'POST',headers,body:JSON.stringify({expectedRevision:artifact.expectedRevision,review,reviewHash:digest(review)})});
  const result=await response.json();ensure(response.ok&&!result.error,result.error??'TOOL_REVIEW',result.message??'reconciliation failed');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};ensure(value('--state'),'RECOVERY_INPUT','explicit --state required');console.log(JSON.stringify(await recovery({stateDirectory:value('--state'),turnId:value('--close-turn'),keepUnknownReserve:args.includes('--keep-unknown-reserve'),reviewFile:value('--review'),evidenceFile:value('--evidence'),apply:args.includes('--apply')}),null,2));}
