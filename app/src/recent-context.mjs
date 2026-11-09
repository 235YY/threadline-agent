// 全局最近上下文：所有来源的真实消息按时间合并，最近 limit 条直接进入本轮输入。
// 与长期记忆分开：这里只回答“刚刚各处发生了什么”，不做摘要。
import {refKey} from './contracts.mjs';

const MAX_BYTES=20000; // 90KB 总预算里最近上下文最多占 20KB，超了会 INPUT_OVERFLOW 导致整轮无回复
const clip=(text,max=300)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length<=max?s:s.slice(0,max)+'…';};
const SELF_ACTION_TOOLS=new Set(['qq_send_message','qq_send_private_message','qq_send_group_message','qq_send_sticker','qq_send_voice','qq_speak','qq_send_poke','remember_note']);
const ownAction=tool=>SELF_ACTION_TOOLS.has(tool)||String(tool).startsWith('office_')||String(tool).startsWith('task_')||String(tool).startsWith('github_');
function actionScene(store,action){
  const args=action?.args??{};
  const id=args.id??args.user_id??args.group_id;
  if(args.target==='group'&&id)return `qq/group/${id}`;
  if(args.target==='private'&&id)return `qq/private/${id}`;
  for(const ref of action?.inputRefs??[]){try{const e=store.read(ref.id,ref.revision);if(e?.scene)return e.scene;}catch{}}
  return action?.scene??null;
}
function actionText(action){
  const args=action?.args??{},failed=action?.status==='failed',uncertain=action?.status==='uncertain';
  let text='';
  if(action.tool==='remember_note')text=`记下：${clip(args.body??'',180)}`;
  else if(action.tool==='qq_send_sticker')text='[表情]';
  else if(action.tool==='qq_send_voice')text='[语音]';
  else if(action.tool==='qq_speak')text=`[语音] ${clip(args.text??'',180)}`;
  else if(action.tool==='qq_send_poke')text='[戳一戳]';
  else if(action.tool==='office_write')text=`写办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_read')text=`读办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_edit')text=`改办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_list')text=`列办公室：${clip(args.path??'.',120)}`;
  else if(action.tool==='office_search')text=`搜办公室：${clip(args.query??'',120)}`;
  else if(action.tool==='task_create')text=`建任务：${clip(args.goal??'',180)}`;
  else if(action.tool==='task_update')text=`更新任务：${clip(args.id??'',80)}`;
  else if(action.tool==='task_list')text='看自己的任务';
  else if(action.tool==='task_get')text=`看任务：${clip(args.id??'',80)}`;
  else if(action.tool==='github_status')text='看GitHub配置';
  else if(action.tool==='github_repo')text='看GitHub仓库';
  else if(action.tool==='github_issues')text='看GitHub issue列表';
  else if(action.tool==='github_issue')text=`看GitHub issue #${args.number??''}`;
  else if(action.tool==='github_pulls')text='看GitHub PR列表';
  else if(action.tool==='github_branches')text='看GitHub分支';
  else if(action.tool==='github_create_branch')text=`开GitHub分支：${clip(args.branch??'',120)}`;
  else if(action.tool==='github_put_file')text=`写GitHub文件：${clip(args.path??'',120)} @ ${clip(args.branch??'',80)}`;
  else if(action.tool==='github_create_pr')text=`开PR：${clip(args.title??'',120)}`;
  else text=clip(args.text??args.message??'',300);
  return `${uncertain?'[结果未知] ':failed?'[未发出] ':''}${text}`.trim();
}
export function recentContext({store,subjectId,currentEvent=null,limit=50}={}){
  const items=[];
  for(const event of store.all('event')){
    if(!['observed','reported'].includes(event.origin))continue;
    if(currentEvent&&event.id===currentEvent.id)continue; // 当前这条已单独作为 currentEvent 进入输入，不重复
    const raw=String(event.body??'');
    const unavailable=/(^|\n)\[图片\]\s*$/.test(raw.trim())&&!raw.includes('[图片内容');
    const isSelf=event.actor===subjectId||event.sender?.id===subjectId||event.sender?.isSelf===true;
    items.push({at:event.occurredAt??event.recordedAt,role:isSelf?'self':'user',author:isSelf?'self':'other',self:isSelf,source:event.source?.system??null,scene:event.scene,sender:event.sender??null,
      ...(unavailable?{imageUnavailable:true}:{}),text:unavailable?'[旧图片记录：当时未接入看图，内容不可用]':clip(raw),ref:{id:event.id,revision:event.revision}});
  }
  const responseScene=response=>{
    try{const d=store.read(response.decision?.id);const e=d?.currentEvent?store.read(d.currentEvent.id):null;if(e?.scene)return e.scene;}catch{}
    return response.scene??null;
  };
  for(const response of store.all('response')){
    if(response.subject!==subjectId||!response.body)continue;
    // response 每次改状态（认领/送达）都会重写 recordedAt；排序要用她“说出口”的首个版本时间，否则送达后会跳到最后
    let first=null;try{first=store.read(response.id,1);}catch{}
    const at=response.sentAt??response.createdAt??first?.createdAt??first?.recordedAt??response.recordedAt;
    items.push({at,role:'self',author:'self',self:true,kind:'message',scene:responseScene(response),text:clip(response.body),status:response.status,ref:{id:response.id,revision:response.revision}});
  }
  for(const action of store.all('action')){
    if((action.subject&&action.subject!==subjectId)||!ownAction(action.tool))continue;
    if(!['succeeded','failed','uncertain'].includes(action.status))continue;
    const text=actionText(action);
    if(!text)continue;
    let result=null;
    if(action.receipt){try{const receipt=store.read(action.receipt.id,action.receipt.revision);if(receipt?.body)result=clip(receipt.body,240);}catch{}}
    items.push({at:action.recordedAt,role:'self',author:'self',self:true,kind:'action',tool:action.tool,status:action.status,
      scene:actionScene(store,action),text,...(result?{result}:{}),ref:{id:action.id,revision:action.revision}});
  }
  items.sort((a,b)=>(a.at??0)-(b.at??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  let selected=items.slice(-Math.max(1,Math.min(100,limit)));
  // 超字节预算时丢最旧的，保留最新
  let bytes=Buffer.byteLength(JSON.stringify(selected));
  while(selected.length>1&&bytes>MAX_BYTES){bytes-=Buffer.byteLength(JSON.stringify(selected[0]))+1;selected=selected.slice(1);}
  return {format:'recent-context-v1',scope:'all-sources',count:selected.length,items:selected};
}
