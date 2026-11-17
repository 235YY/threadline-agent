export function acceptsChat({privateChat,userId},{scope,ownerOnly}={}){
 if(scope==='all')return true;
 return !ownerOnly||(privateChat&&String(userId)===String(ownerOnly));
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
