export function blockedChatSet(env={}){
 const out=new Set();
 for(const g of String(env.QQ_BLOCKED_GROUPS??'').split(',')){const id=g.trim();if(/^\d+$/.test(id))out.add('qq/group/'+id);}
 for(const c of String(env.QQ_BLOCKED_CHATS??'').split(',')){const s=c.trim();if(/^qq\/(private|group)\/\d+$/.test(s))out.add(s);}
 return out;
}
export function acceptsChat({privateChat,userId,groupId,scene},{scope,ownerOnly,blockedChats}={}){
 const s=scene??(privateChat&&userId!==undefined?'qq/private/'+userId:!privateChat&&groupId!==undefined?'qq/group/'+groupId:null);
 if(s&&blockedChats?.has?.(s))return false;
 if(scope==='all')return true;
 return !ownerOnly||(privateChat&&String(userId)===String(ownerOnly));
}
export function isGroupAddressed(event,{selfId,policy='all',wakeKeywords=[]}={}){
 if(event?.message_type!=='group')return true;
 if(policy==='all')return true;
 const segs=Array.isArray(event?.message)?event.message:[];
 const mentioned=selfId!==undefined&&selfId!==null&&segs.some(s=>s?.type==='at'&&String(s.data?.qq)===String(selfId));
 if(mentioned)return true;
 if(policy==='mentioned')return false;
 if(policy==='wake'){
  const text=segs.filter(s=>s?.type==='text').map(s=>s.data?.text??'').join('')||String(event?.raw_message??'');
  return wakeKeywords.some(k=>k&&text.includes(k));
 }
 return true;
}
export function canStopAll(userId,owner){return !!owner&&String(userId)===String(owner);}

export function noticeScene(event){
 const type=String(event?.notice_type??'');if(!['group_recall','friend_recall','group_poke','friend_poke','notify'].includes(type))return null;
 const numeric=value=>/^\d+$/.test(String(value??''));
 if(type==='notify'&&event.sub_type!=='poke')return null;
 if(numeric(event.group_id)&&numeric(event.user_id??event.operator_id))return 'qq/group/'+event.group_id;
 if((type.startsWith('friend_')||type==='notify'&&event.sub_type==='poke')&&numeric(event.user_id))return 'qq/private/'+event.user_id;
 return null;
}
