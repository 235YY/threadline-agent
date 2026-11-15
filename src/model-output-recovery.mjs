import {digest,ensure} from './contracts.mjs';
// Only mechanical syntax/envelope checks. Core evidence/permission validation stays authoritative.
export function proposalFormatIssue(raw,packet){
 let o;try{o=JSON.parse(raw);}catch(e){return {code:'OUTPUT_JSON',path:'output',message:String(e.message).slice(0,240)};}
 const issue=(path,message)=>({code:'OUTPUT_ENVELOPE',path,message});
 if(!o||typeof o!=='object'||Array.isArray(o))return issue('output','需要JSON对象');
 if(o.packetId!==packet.packetId)return issue('packetId','必须与本轮输入packetId一致');
 if(!Array.isArray(o.options)||!o.options.length)return issue('options','需要非空候选数组');
 if(typeof o.selected!=='string'||!o.options.some(x=>x?.id===o.selected))return issue('selected','必须选择本稿实际存在的候选ID');
 if(!o.continuity||typeof o.continuity!=='object'||Array.isArray(o.continuity))return issue('continuity','需要本轮continuity对象；无需修改的内容可表达为空增量');
 return null;
}
export function selectedModelOutput(rows,primary){
 ensure(primary?.status==='settled','MODEL_ACCOUNTING','primary attempt not settled');
 const recovery=primary.proposalRecovery;
 if(recovery){const attempt=rows.find(r=>r.id===recovery.attemptId);ensure(!attempt||attempt.status==='settled','UNCERTAIN_REQUEST','corrective attempt is not confirmed; preserve reservation and never resend');}
 if(recovery?.selected){
  const attempt=rows.find(r=>r.id===recovery.attemptId);
  ensure(recovery.attemptId===`repair:${primary.id.slice(5)}:1`&&attempt?.status==='settled'&&attempt.providerResult?.complete===true&&typeof attempt.output==='string'&&digest(attempt.output)===recovery.outputHash,'MODEL_CAPTURE_MISSING','selected corrective attempt is not durably verified; never resend');
  return {output:attempt.output,attemptId:attempt.id,primaryId:primary.id,corrected:true};
 }
 ensure(typeof primary.output==='string','MODEL_CAPTURE_MISSING','captured output missing');
 return {output:primary.output,attemptId:primary.id,primaryId:primary.id,corrected:false};
}
export async function recoverOutputOnce({packet,primary,ledger,client,verified,providerMessages,timeoutMs,startedAt,beforeCorrection=null}){
 const issue=proposalFormatIssue(primary.output,packet);if(!issue)return primary.output;
 const attemptId=`repair:${packet.packetId}:1`,packetHash=digest(packet),existing=primary.proposalRecovery;
 ensure(!existing||existing.attemptId===attemptId&&existing.packetHash===packetHash,'MODEL_RECOVERY_CHANGED','recovery belongs to another frozen input');
 if(existing?.selected)return selectedModelOutput(ledger.data.requests,primary).output;
 if(existing?.closed)return primary.output;
 const feedback={kind:'host-format-feedback',packetId:packet.packetId,issue,adopted:false,savedBusinessChanges:false,toolExecution:'not-started',remainingAutomaticCorrections:0,instruction:'前稿未被采用，任何查询/发送/状态修改均未执行。原任务、材料和固定版本如下，原稿也保留。请重新提交完整JSON候选，保留packetId。不要将提案说成已执行；可以自主选择回应、查阅、等待等合法选项。不要猜证据、对象版本或权限。只有一次自动重填机会。'};
 const messages=[...providerMessages,{role:'assistant',content:primary.output},{role:'user',content:JSON.stringify(feedback)}],bytes=Buffer.byteLength(JSON.stringify(messages));
 const close=reason=>{primary.proposalRecovery={...primary.proposalRecovery,closed:true,reason};ledger.save();return primary.output;};
 if(!existing){primary.proposalRecovery={attemptId,packetHash,issue,feedback,selected:false};ledger.save();}
 if(bytes>packet.budgetBytes)return close('CORRECTION_INPUT_LIMIT');
 if(Date.now()-startedAt>=timeoutMs)return close('CORRECTION_TIME_LIMIT');
 let attempt=ledger.tryFind(attemptId);
 if(attempt){
  ensure(attempt.status==='settled'&&attempt.providerResult,'TRANSPORT_REPLAY','corrective attempt already entered; do not resend');
  if(typeof attempt.output!=='string'&&typeof attempt.providerResult.output==='string')ledger.attachOutput(attemptId,attempt.providerResult.output);
 }else{
  try{await beforeCorrection?.();const r=await client.call({id:attemptId,packet:{...verified,packetId:packet.packetId,payload:packet.payload,messages,bytes},signal:AbortSignal.timeout(Math.max(1,Math.min(timeoutMs-(Date.now()-startedAt),60000)))});ledger.attachProviderResult(attemptId,r);ledger.attachOutput(attemptId,r.output);attempt=ledger.find(attemptId);}
  catch(error){if(!ledger.tryFind(attemptId)&&['SPEND_LIMIT','CALL_LIMIT','TASK_CALL_BUDGET','AGENT_CONTROL_CHANGED','AGENT_LEASE_LOST','INTENT_TASK_REVIEW_REQUIRED','NETWORK_PREFLIGHT_FAILED','CANCELLED'].includes(error.code))return close(error.code);throw error;}
 }
 if(!attempt.providerResult.complete||!attempt.output?.trim())return close('CORRECTION_INCOMPLETE');
 const secondIssue=proposalFormatIssue(attempt.output,packet);if(secondIssue){primary.proposalRecovery={...primary.proposalRecovery,secondIssue};return close('CORRECTION_REJECTED');}
 primary.proposalRecovery={...primary.proposalRecovery,selected:true,closed:true,outputHash:digest(attempt.output)};ledger.save();return attempt.output;
}
