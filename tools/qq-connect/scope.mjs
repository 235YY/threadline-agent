export function acceptsChat({privateChat,userId},{scope,ownerOnly}={}){
 if(scope==='all')return true;
 return !ownerOnly||(privateChat&&String(userId)===String(ownerOnly));
}
export function canStopAll(userId,owner){return !!owner&&String(userId)===String(owner);}
