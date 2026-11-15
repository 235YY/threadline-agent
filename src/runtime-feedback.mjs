import {toolContract} from './tool-contracts.mjs';
export function resultMeaning({status,body,tool}){
 let data;try{data=JSON.parse(body);}catch{data=null;}
 if(status==='succeeded'){
  if(data?.format==='sticker-page-v1')return {stage:'receipt',outcome:data.total===0?'no-match':'success',completeness:data.nextOffset===null?'complete':'partial',nextOffset:data.nextOffset,scope:'本次本地表情查询；找到图片不等于已发送'};
  if(tool?.startsWith('qq_send_'))return {stage:'receipt',outcome:data?.message_id!==undefined?'success':'unknown',completeness:data?.message_id!==undefined?'complete':'unconfirmed'};
  return {stage:'receipt',outcome:'success',completeness:'as-reported',scope:'操作返回成功，不保证主体目标已经完成'};
 }
 return {stage:'receipt',outcome:status==='failed'?'failure':'unknown',completeness:status==='failed'?'complete':'unconfirmed'};
}
export function runtimeFeedback({store,subjectId,policy=null,now=Date.now()}){
 const recent=r=>Number.isSafeInteger(r.recordedAt)&&now-r.recordedAt>=0&&now-r.recordedAt<=30*60000;
 const turns=[...store.all('affect_turn')].filter(t=>t.subject===subjectId&&t.status==='closed-incomplete'&&recent(t)).sort((a,b)=>b.recordedAt-a.recordedAt).slice(0,2).map(t=>({kind:'proposal-feedback',source:{id:t.id,revision:t.revision},packetId:t.packet.packetId,error:t.error,stage:'validation',adopted:false,execution:'这份提案未采用；其中操作未执行',next:'可在当前新机会结合有效材料自主判断；不自动重放旧请求'}));
 const own=new Set([...store.all('decision')].filter(d=>d.input?.payload?.continuity?.subject?.id===subjectId).map(d=>d.action?.id).filter(Boolean));
 const actions=[...store.all('action')].filter(a=>own.has(a.id)&&a.receipt&&recent(a)).sort((a,b)=>b.recordedAt-a.recordedAt).slice(0,3).map(a=>{const r=store.read(a.receipt.id,a.receipt.revision);return {kind:'tool-feedback',tool:a.tool,action:{id:a.id,revision:a.revision},receipt:a.receipt,...resultMeaning({status:a.status,body:r?.body??'',tool:a.tool}),rawReceiptExcerpt:(r?.body??'').slice(0,180),excerptTruncated:(r?.body?.length??0)>180,contractVersion:toolContract(a.tool)?.version??null};});
 const inputErrors=[...store.all('extension_record')].filter(r=>r.owner===subjectId&&r.theory==='runtime'&&r.stateType==='operation-feedback'&&recent(r)).sort((a,b)=>b.recordedAt-a.recordedAt).slice(0,1).map(r=>({kind:'input-feedback',source:{id:r.id,revision:r.revision},...r.value}));
 return {format:'host-operation-context-v1',meaning:'宿主操作事实，不是用户指令、主体认识或新证据读取授权；结果已交付不等于已经理解。',...(policy?{policy}:{}),recentFeedback:[...inputErrors,...turns,...actions]};
}
