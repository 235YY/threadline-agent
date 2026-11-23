import {normalizeMessage,projectText} from '../../src/message.mjs';
// 适配器只做协议映射：QQ 私聊/群聊、MC 聊天 → 场景 + 观察。不登录、不直连。
import {ensure,text} from '../../src/contracts.mjs';

export function normalizeInbound({source='qq',key,text:body,message:messageValue=null,actor,at,sourceKey=null,scene:givenScene=null,sender=null,occurredAt=null,threadId=null}={}){
  text(key,'source key');
  if(messageValue!==null)body=projectText(normalizeMessage(messageValue));
  text(body,'message body');
  if(sourceKey!==null)text(sourceKey,'source key');
  if(threadId!==null){text(threadId,'threadId');ensure([...threadId].length<=200,'ADAPTER','threadId too long');}
  ensure(typeof source==='string'&&/^[a-z0-9_-]+$/i.test(source),'ADAPTER','source must be a simple system id');
  let scene=givenScene;
  if(scene!==null){
    text(scene,'scene');
  }else if(source==='qq'){
    if(/^private:.+/.test(key))scene=`qq/private/${key.slice('private:'.length)}`;
    else if(/^group:.+/.test(key))scene=`qq/group/${key.slice('group:'.length)}`;
    else ensure(false,'ADAPTER','qq key must be private:* or group:*');
  }else{
    ensure(/^[a-z0-9_-]+$/i.test(key),'ADAPTER','source key must be a simple id');
    scene=`${source}/${key}`;
  }
  return {source,key:sourceKey??`${source}:${key}`,scene,actor:actor??(sender?.entityId??(source==='qq'?'qq-user':source==='mc'?'mc-player':`${source}-user`)),sender,body,message:messageValue,at:occurredAt??at,threadId};
}

export function outboundTarget({scene,text:body}){
  text(scene,'scene');text(body,'reply body');
  if(scene.startsWith('qq/private/'))return {kind:'qq',key:`private:${scene.slice('qq/private/'.length)}`};
  if(scene.startsWith('qq/group/'))return {kind:'qq',key:`group:${scene.slice('qq/group/'.length)}`};
  if(scene.startsWith('mc/'))return {kind:'mc',key:scene.slice('mc/'.length)};
  ensure(false,'ADAPTER','unknown scene for outbound');
}
