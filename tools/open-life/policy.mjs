import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {writeLedgerAtomically} from '../../src/ledger-io.mjs';
import {sourceReplyRoute} from '../../src/reply-route.mjs';

export const OPEN_LIFE_TOOLS=Object.freeze([
 'tool_contract','qq_list_friends','qq_list_groups','qq_get_group_info','qq_get_group_members','qq_get_group_history','qq_get_friend_history','qq_get_forward_msg',
 'qq_list_stickers','qq_send_sticker','qq_send_message','qq_send_image','qq_send_voice','qq_speak','qq_list_voices',
 'anchor_recall','attention_status','attention_mute','attention_unmute','attention_load','style_status',
 'web_search','web_fetch','bilibili_search','bilibili_video_meta','bilibili_comments','bilibili_column_text','qq_watch_video',
 'github_search','github_repo_readme','github_repo_tree','github_issue_read','github_release_read',
 'office_status','office_list','office_read','office_search','office_write','office_edit','qq_minecraft'
]);
const fail=(code,message)=>Object.assign(new Error(message),{code,transportInvoked:false});
const day=now=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function openLifePolicy({file,botId,ownerId,store=()=>null,now=Date.now,save=writeLedgerAtomically,blockedLegacyIds=[]}={}){
 if(!file||!/^\d+$/.test(String(botId))||!/^\d+$/.test(String(ownerId)))throw fail('LIFE_CONFIG','explicit Bot, owner and persistent policy file required');
 let data={format:'jingyang-open-life-policy-v1',botId:String(botId),lastReflectionAt:null,explorations:[],contacts:{},sends:{}};
 if(existsSync(file)){data=JSON.parse(readFileSync(file,'utf8'));if(data.format!=='jingyang-open-life-policy-v1'||data.botId!==String(botId)||!Array.isArray(data.explorations)||!data.sends||!data.contacts)throw fail('LIFE_STATE','policy state invalid; preserve it for review');}
 const persist=()=>save(file,data);
 const held=new Set(blockedLegacyIds);
 function assertOperationCurrent(reference){if(reference?.id&&held.has(reference.id))throw fail('LEGACY_OPERATION_HELD','historical pending or unconfirmed operation stays held; expanded V15 grants are not retroactive');}
 function route(context={}){
  const s=store();if(!s)return null;
  const options={read:(id,revision)=>s.read(id,revision),all:type=>s.all(type),subjectId:'jingyang'};
  if(context.response){const response=s.read(context.response.id,context.response.revision),decision=response?.decision?s.read(response.decision.id,response.decision.revision):null;return decision?.currentEvent?sourceReplyRoute({...options,event:decision.currentEvent}).scene:null;}
  if(context.task){const task=context.task,decision=task.originDecisionRef?s.read(task.originDecisionRef.id,task.originDecisionRef.revision):null,event=task.originEventRef??decision?.currentEvent;return event?sourceReplyRoute({...options,event}).scene:null;}
  return sourceReplyRoute({...options,...(context.action?{action:context.action}:{})}).scene??null;
 }
 function key(context={}){assertOperationCurrent(context.action??context.response);const s=store();if(context.action?.id&&s?.read(context.action.id,context.action.revision)?.type==='action')return 'action:'+context.action.id;if(context.response?.id&&s?.read(context.response.id,context.response.revision)?.type==='response')return 'response:'+context.response.id;if(context.task?.id&&s?.read(context.task.id)?.type==='agent_task')return 'task:'+context.task.id+':'+context.task.stepCount;throw fail('LIFE_CONTEXT_REQUIRED','send requires the real committed Action, Response or task step');}
 function restrictPrivateRead(tool,args,context){
  const source=route(context);if(!source||source===`qq/private/${ownerId}`)return;
  if(tool==='qq_get_friend_history'&&source!==`qq/private/${args.user_id??args.id}`)throw fail('PRIVATE_SCOPE','this conversation cannot fetch another person\'s private history');
 }
 return {
  route,key,restrictPrivateRead,assertOperationCurrent,
  canReflect(at=now()){return data.lastReflectionAt===null||at-data.lastReflectionAt>=7200000;},
  recordReflection(at=now()){if(!this.canReflect(at))throw fail('IDLE_COOLDOWN','idle reflection is still cooling down');data.lastReflectionAt=at;persist();},
  beforeTask({action,decision}){
   if(decision?.input?.stage!=='reflection')return;
   const id='action:'+action.id;if(data.explorations.some(x=>x.id===id))return;
   if(data.explorations.filter(x=>x.day===day(now())).length>=3)throw fail('EXPLORATION_LIMIT','three autonomous exploration attempts already entered today; wait for another day');
   data.explorations.push({id,day:day(now()),at:now()});persist();
  },
  async send({tool,args,context,targetScene,knownTargets,invoke}){
   if(!knownTargets.has(targetScene))throw fail('QQ_SCOPE','target is not an actual friend or joined group of this Bot');
   const id=key(context),signature=digest({tool,args,targetScene}),prior=data.sends[id];
   if(prior){if(prior.signature!==signature)throw fail('REQUEST_COLLISION','one committed operation cannot change its send payload');if(prior.status==='confirmed')return prior.result;throw fail('SEND_OUTCOME_UNKNOWN','previous send outcome is not confirmed; do not resend');}
   const origin=route(context),proactive=origin!==targetScene;
   if(proactive){if(typeof args.reason!=='string'||!args.reason.trim())throw fail('SOCIAL_REASON_REQUIRED','proactive contact needs the subject\'s own explicit reason');if(now()-(data.contacts[targetScene]??-Infinity)<1800000)throw fail('SOCIAL_COOLDOWN','this proactive target is still in its 30-minute cooldown');}
   data.sends[id]={signature,status:'entered',at:now(),targetScene,proactive};if(proactive)data.contacts[targetScene]=now();try{persist();}catch(error){error.transportInvoked=false;throw error;}
   try{const result=await invoke();if(result?.message_id===undefined)throw Error('QQ receipt has no message_id');data.sends[id]={...data.sends[id],status:'confirmed',result};try{persist();}catch(error){return {...result,policyRecording:'failed',policyError:error.code??error.name,meaning:'QQ confirmed this message_id; auxiliary recording failed; do not resend'};}return result;}
   catch(error){data.sends[id]={...data.sends[id],status:'unknown',error:error.code??error.name};try{persist();}catch{}error.transportInvoked=true;throw error;}
  },
  snapshot(){return structuredClone(data);}
 };
}
