// Pure OneBot-event → brain message parts. No network/login/model.
const isHttp=url=>/^https?:\/\//i.test(String(url??''));
function segmentPart(segment){
  const data=segment?.data??{};
  if(segment?.type==='text')return {type:'text',text:data.text??''};
  if(segment?.type==='at')return {type:'text',text:`@${data.name??data.qq??''}`};
  if(segment?.type==='face')return {type:'text',text:`[表情${data.id?`:${data.id}`:''}]`};
  if(segment?.type==='image'){const url=[data.url,data.file,data.path].find(isHttp);return {type:'image',url:url??null,file:url?null:(data.file?String(data.file):null),mime:data.mime??data.mime_type??null,fileId:data.file_id??data.file??null};}
  if(segment?.type==='record')return {type:'text',text:String(data.text??data.transcript??'').trim()||'[语音]'};
  if(segment?.type==='reply')return {type:'text',text:'[引用]'};
  if(segment?.type==='forward')return {type:'text',text:'[合并转发]'};
  if(segment?.type==='json'||segment?.type==='xml')return {type:'text',text:'[卡片]'};
  return null;
}
function partText(part){return part?.type==='text'?part.text:part?.type==='image'?'[图片]':'';}
export function buildReplyPayload(event,{selfId=0,ownerId=null,threadId=null}={}){
  if(!event||event.message_type!=='private'&&event.message_type!=='group')throw new Error('private or group event required');
  const privateChat=event.message_type==='private';
  const scene=privateChat?`qq/private/${event.user_id}`:`qq/group/${event.group_id}`;
  const key=privateChat?`private:${event.user_id}`:`group:${event.group_id}`;
  const sender={system:'qq',id:String(event.user_id),name:String(event.sender?.card||event.sender?.nickname||event.user_id),
    entityId:`person:qq:${event.user_id}`,isOwner:ownerId!==null&&String(event.user_id)===String(ownerId)};
  const occurredAt=Number.isSafeInteger(event.time)?event.time*1000:Date.now();
  const segments=Array.isArray(event.message)?event.message:[];
  const parts=segments.map(segmentPart).filter(Boolean);
  const text=parts.map(partText).join('').trim();
  const attachments=parts.filter(p=>p.type==='image'&&p.url).map(p=>({kind:'image',url:p.url,mime:p.mime,fileId:p.fileId}));
  const replyTo=segments.find(s=>s?.type==='reply')?.data?.id??null;
  const forwardId=segments.find(s=>s?.type==='forward')?.data?.id??null;
  const voice=segments.find(s=>s?.type==='record')?.data?.text??segments.find(s=>s?.type==='record')?.data?.transcript??null;
  return {protocol:'jingyang-brain-bridge-v1',key,scene,message_id:event.message_id,execute:false,sender,occurredAt,
    threadId:threadId??event.threadId??event.thread_id??null,messages:[{role:'user',content:text}],parts,attachments,replyTo,forwardId,voice};
}
