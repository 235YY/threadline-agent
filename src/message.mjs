// Threadline 消息规范：内部只认 content parts，不认 provider-specific wire format。
// 旧事件没有 message 时，由 fromLegacyBody 投影成 text message。
import {createHash} from 'node:crypto';
import {ensure} from './contracts.mjs';

export const MESSAGE_FORMAT='jingyang-message-v1';
export const MESSAGE_ROLES=Object.freeze(['user','assistant','tool']);
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const normalizeMime=v=>String(v||'').toLowerCase().replace('image/jpg','image/jpeg').replace('image/pjpeg','image/jpeg').replace('image/x-png','image/png');
const HASH=/^[a-f0-9]{64}$/;

function frozen(value){return JSON.parse(JSON.stringify(value));}
export function textPart(text){
  ensure(typeof text==='string','MESSAGE','text part requires string');
  return {type:'text',text};
}
export function imagePart({ref,hash,mediaType,bytes,sourceUrl=null}={}){
  ensure(typeof ref==='string'&&ref.startsWith('blobs/'),'MESSAGE','image ref must be blobs/<hash>');
  const normalizedHash=ref.slice('blobs/'.length);
  ensure(HASH.test(normalizedHash),'MESSAGE','invalid blob hash');
  ensure(hash===undefined||hash===normalizedHash,'MESSAGE','image hash must match ref');
  ensure(IMAGE_TYPES.has(String(mediaType).toLowerCase()),'MESSAGE','unsupported image media type');
  ensure(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=32*1024*1024,'MESSAGE','bounded image bytes required');
  ensure(sourceUrl===null||/^https?:\/\//i.test(String(sourceUrl)),'MESSAGE','image sourceUrl must be http(s)');
  return {type:'image',ref,hash:normalizedHash,mediaType:normalizeMime(mediaType),bytes,...(sourceUrl?{sourceUrl:String(sourceUrl)}:{})};
}
export function contentPart(part){
  ensure(part&&typeof part==='object'&&!Array.isArray(part),'MESSAGE','content part object required');
  if(part.type==='text')return textPart(part.text);
  if(part.type==='image')return imagePart(part);
  throw Object.assign(new Error('unsupported content part'),{code:'MESSAGE_PART'});
}
export function message(role,content){
  ensure(MESSAGE_ROLES.includes(role),'MESSAGE','invalid role');
  ensure(Array.isArray(content)&&content.length>0&&content.length<=16,'MESSAGE','content parts required');
  const parts=content.map(contentPart);
  ensure(parts.some(p=>p.type==='text'&&p.text.length>0)||parts.some(p=>p.type==='image'),'MESSAGE','empty message');
  return {format:MESSAGE_FORMAT,role,content:parts};
}
export function fromLegacyBody(body){
  ensure(typeof body==='string','MESSAGE','legacy body must be string');
  return message('user',[textPart(body)]);
}
export function normalizeMessage(value,{role='user',body=null}={}){
  if(value===undefined||value===null)return fromLegacyBody(body??'');
  ensure(value?.format===MESSAGE_FORMAT,'MESSAGE','unsupported message format');
  const normalized=message(value.role??role,value.content);
  if(body!==null)ensure(projectText(normalized)===body,'MESSAGE','body must be the text projection of message');
  return normalized;
}
export function projectText(messageValue){
  ensure(messageValue?.format===MESSAGE_FORMAT,'MESSAGE','message required');
  return messageValue.content.map(p=>p.type==='text'?p.text:'[图片]').join('');
}
export function messageHash(messageValue){
  return createHash('sha256').update(JSON.stringify(messageValue)).digest('hex');
}
export function messageImageRefs(messageValue){
  ensure(messageValue?.format===MESSAGE_FORMAT,'MESSAGE','message required');
  return messageValue.content.filter(p=>p.type==='image').map(p=>({...p,eventRef:p.eventRef??null}));
}
export function plainMessage(messageValue){return frozen(messageValue);}
