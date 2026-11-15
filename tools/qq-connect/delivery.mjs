// A claim is durable before the external call. Missing acknowledgement never triggers a resend.
export async function deliverClaimedResponse(item,{request,send}){
  if(item.delivery?.status)return {skipped:true,status:item.delivery.status};
  if(!item.response)throw Object.assign(Error('response identity required'),{code:'RESPONSE_REQUIRED'});
  const claim=await request('/v1/response/claim',{response:item.response});
  try{await send(item);}catch(error){
    try{await request('/v1/response/delivered',{...claim,outcome:'unknown',body:error.message});}catch{}
    throw error;
  }
  await request('/v1/response/delivered',{...claim,outcome:'sent',body:'连接器收到发送回执'});
  return {status:'sent'};
}
export async function deliverClaimedAction(item,{request,execute,scene,eventId}){
  if(item.execution?.status)return {skipped:true,status:item.execution.status};
  const claim=await request('/v1/action/claim',{action:item.action});let body,status='succeeded';
  try{body=JSON.stringify(await execute(item));}catch(error){status='interrupted';body=error.message;}
  await request('/v1/receipt',{...claim,scene,status,body:body??'',eventId});
  return {status};
}
