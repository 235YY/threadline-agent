export const QUOTA_PAUSE_CODES=Object.freeze(['DAILY_BUDGET_LIMIT','SPEND_LIMIT','CALL_LIMIT','BUDGET_EXPIRED','BUDGET_HALTED']);
export const FATAL_RECEIVE_CODES=Object.freeze(['RECEIVE_STATE_UNAVAILABLE','RECEIVE_RECOVERY_REQUIRED','RECEIVE_STATE_INVALID','RECEIVE_BACKLOG_LIMIT']);

export function classifyBridgeError(error){
  const code=error?.code;
  if(QUOTA_PAUSE_CODES.includes(code))return 'quota';
  if(FATAL_RECEIVE_CODES.includes(code))return 'fatal';
  return 'transient';
}

export function messageText(event){
  const parts=Array.isArray(event?.message)?event.message.filter(s=>s?.type==='text').map(s=>s.data?.text??''):[];
  return parts.join('').trim();
}

export function isAddressed(event,{selfId='',wakeWords=[],listenAll=false}={}){
  if(!event)return false;
  if(event.message_type==='private')return true;
  if(listenAll)return true;
  const segments=Array.isArray(event.message)?event.message:[];
  if(selfId!==''&&selfId!==null&&selfId!==undefined&&segments.some(s=>s?.type==='at'&&String(s.data?.qq)===String(selfId)))return true;
  const text=messageText(event);
  return wakeWords.some(word=>word&&text.includes(word));
}

export function applyContextToParts(content,{context='',quoteText=null,forwardText=null,textPart=text=>({type:'text',text})}={}){
  const quote=(quoteText??(String(context).match(/^(\[引用[\s\S]*?\])\n?/)?.[1]??'')).trim();
  const forward=(forwardText??(String(context).match(/\n(\[合并转发[\s\S]*?\])$/)?.[1]??'')).trim();
  if(quote)content.unshift(textPart(quote+'\n'));
  if(forward){
    const suffix='\n'+forward;
    if(content.at(-1)?.type==='text')content.at(-1).text+=suffix;
    else content.push(textPart(suffix));
  }
  if(content.length===0)content.push(textPart(context));
  return content;
}

export function normalizeNoticeEvent(event,{ownerQQ=null}={}){
  const type=String(event?.notice_type??'');
  if(!['group_recall','friend_recall','group_poke','friend_poke','notify'].includes(type))return null;
  const privateChat=type.startsWith('friend_')||!event.group_id;
  if(privateChat&&!event?.user_id||!privateChat&&!event?.group_id)return null;
  const scene=privateChat?`qq/private/${event.user_id}`:`qq/group/${event.group_id}`;
  const key=privateChat?`private:${event.user_id}`:`group:${event.group_id}`;
  const body=type.endsWith('_recall')?`[撤回] ${event.message_id??''}`:type.endsWith('_poke')?`[拍一拍] ${event.target_id??event.user_id??''}`:`[${type}]`;
  const actor=String(event.user_id??event.operator_id??'0');
  const sender={system:'qq',id:actor,name:actor==='0'?'qq':actor,entityId:`person:qq:${actor}`,isOwner:ownerQQ!==null&&ownerQQ!==undefined&&actor===String(ownerQQ)};
  const occurredAt=Number.isSafeInteger(event.time)?event.time*1000:Date.now();
  return {type,privateChat,scene,key,body,sender,occurredAt};
}
