// 全局最近上下文：所有来源的真实消息按时间合并，最近 limit 条直接进入本轮输入。
// 与长期记忆分开：这里只回答“刚刚各处发生了什么”，不做摘要。
import {refKey} from './contracts.mjs';

const clip=(text,max=600)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length<=max?s:s.slice(0,max)+'…';};
export function recentContext({store,subjectId,currentEvent=null,scene=null,limit=50}={}){
  const items=[];
  for(const event of store.all('event')){
    if(!['observed','reported'].includes(event.origin))continue;
    if(scene!==null&&event.scene!==scene)continue;
    items.push({at:event.occurredAt??event.recordedAt,role:'user',scene:event.scene,sender:event.sender??null,text:clip(event.body),...(event.message?{message:event.message}:{}),ref:{id:event.id,revision:event.revision}});
  }
  const responseScene=response=>{
    try{const d=store.read(response.decision?.id);const e=d?.currentEvent?store.read(d.currentEvent.id):null;if(e?.scene)return e.scene;}catch{}
    return response.scene??null;
  };
  for(const response of store.all('response')){
    if(response.subject!==subjectId||!response.body)continue;
    if(response.status!=='sent')continue;
    const responseSceneValue=responseScene(response);
    if(scene!==null&&responseSceneValue!==scene)continue;
    items.push({at:response.recordedAt,role:'her',scene:responseSceneValue,text:clip(response.body),status:response.status,ref:{id:response.id,revision:response.revision}});
  }
  items.sort((a,b)=>(a.at??0)-(b.at??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  const selected=items.slice(-Math.max(1,Math.min(100,limit)));
  return {format:'recent-context-v1',scope:'all-sources',count:selected.length,items:selected};
}
