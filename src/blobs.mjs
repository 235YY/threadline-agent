// 内容寻址 blob：节点/消息里的图片/文件真正存本地时用；核心只认 hash，不认用户路径。
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from './contracts.mjs';

const MAX_BYTES=8*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const MEDIA=new Set(['image/png','image/jpeg','image/webp','image/gif','text/plain','application/json','application/octet-stream']);
const normalizeMime=v=>String(v||'').toLowerCase().replace('image/jpg','image/jpeg').replace('image/pjpeg','image/jpeg').replace('image/x-png','image/png');
export function putBlob({directory,bytes,mediaType='application/octet-stream'}={}){
  ensure(typeof directory==='string'&&directory.length>0,'BLOB','directory required');
  ensure(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_BYTES,'BLOB','bounded Buffer required');
  const mime=normalizeMime(mediaType);
  ensure(MEDIA.has(mime),'BLOB','unsupported media type');
  const hash=createHash('sha256').update(bytes).digest('hex'),ref=`blobs/${hash}`;
  mkdirSync(directory,{recursive:true});
  const target=join(directory,hash);
  if(!existsSync(target)){
    const tmp=`${target}.${process.pid}.${randomUUID()}.tmp`;
    try{writeFileSync(tmp,bytes,{flag:'wx'});renameSync(tmp,target);}
    finally{try{unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  return {ref,hash,bytes:bytes.length,mediaType:mime};
}
// Temporary names can never be referenced by a committed message.
export function cleanStaleBlobTemps({directory,now=Date.now()}={}){
  let entries;
  try{entries=readdirSync(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries){
    const match=/^[a-f0-9]{64}\.(\d+)(?:\.[a-f0-9-]{36})?\.tmp$/.exec(entry.name);
    if(!entry.isFile()||!match)continue;
    const path=join(directory,entry.name);
    try{
      if(now-statSync(path).mtimeMs<24*60*60*1000)continue;
      try{process.kill(Number(match[1]),0);continue;}
      catch(error){if(error.code!=='ESRCH')continue;}
      unlinkSync(path);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export function readBlob({directory,ref}={}){
  ensure(typeof directory==='string'&&directory.length>0,'BLOB','directory required');
  ensure(typeof ref==='string'&&ref.startsWith('blobs/'),'BLOB','blob ref required');
  const hash=ref.slice('blobs/'.length);ensure(HASH.test(hash),'BLOB','invalid blob hash');
  const target=join(directory,hash);ensure(existsSync(target),'BLOB','blob not found');
  const size=statSync(target).size;ensure(size>0&&size<=MAX_BYTES,'BLOB','blob size out of bounds');
  const bytes=readFileSync(target);ensure(createHash('sha256').update(bytes).digest('hex')===hash,'BLOB','blob hash mismatch');
  return bytes;
}
export function blobMeta({directory,ref}={}){
  const bytes=readBlob({directory,ref});
  return {ref,hash:ref.slice('blobs/'.length),bytes:bytes.length};
}
