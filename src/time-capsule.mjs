// Resident export with a bounded, authenticated envelope. SQLite uses a consistent copy.
import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, rmdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const CAPSULE_FORMAT = 'threadline-time-capsule-v1';
const CAPSULE_ALG = 'aes-256-gcm+scrypt+gzip';
const MAX_BYTES=64*1024*1024;
const MAX_CONTENT=96*1024*1024;
const MAX_FILES=4096;
const ROOT_FILES=new Set(['settings.json','identity.txt','subject.sqlite','requests.json']);
const STATE_FILES=new Set(['state/attention.json','state/scheduler.json','state/context-cursor.json']);
const secretKey=/^(?:api.?key|key|(?:access|refresh).?token|token|secret|password|passphrase|authorization|cookie|private.?key)$/i;

function fail(code) { throw Object.assign(Error(code),{code}); }
function stripSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(stripSecrets);
  if (!obj||typeof obj!=='object') return obj;
  return Object.fromEntries(Object.entries(obj).filter(([k])=>!secretKey.test(k)).map(([k,v])=>[k,stripSecrets(v)]));
}

function allowedPath(path) {
  return typeof path==='string'&&path.length<=220&&path.split('/').every(segment=>
    /^[a-z0-9][a-z0-9._-]*$/i.test(segment)&&!segment.endsWith('.')&&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))&&
    (ROOT_FILES.has(path)||STATE_FILES.has(path)||
      /^skills\/[^/]+\.md$/i.test(path)||/^styles\/(?:index\.json|packs\/[^/]+\.md)$/i.test(path)||
      /^state\/blobs\/(?:[a-f\d]{2}\/)?[a-f\d]{64}(?:\.bin|\.json)?$/i.test(path));
}

function snapshotDatabase(file) {
  const temporary=mkdtempSync(join(tmpdir(),'threadline-capsule-'));
  const snapshot=join(temporary,'memory.sqlite');
  try {
    const db=new DatabaseSync(file,{readOnly:true,timeout:1000});
    try { db.prepare('VACUUM INTO ?').run(snapshot); }
    finally { db.close(); }
    if(lstatSync(snapshot).size>MAX_BYTES)fail('CAPSULE_SIZE_LIMIT_EXCEEDED');
    return readFileSync(snapshot);
  } finally {
    if(existsSync(snapshot))unlinkSync(snapshot);
    rmdirSync(temporary);
  }
}

function readSettings(bytes) {
  const parsed=JSON.parse(bytes.toString('utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('INVALID_CAPSULE_SETTINGS');
  const clean=stripSecrets(parsed);
  clean.live=false;
  if(clean.gateway)clean.gateway.enabled=false;
  delete clean.mcp;
  return Buffer.from(JSON.stringify(clean));
}

function collectResidentFiles(residentDir) {
  const top=lstatSync(residentDir);
  if(!top.isDirectory()||top.isSymbolicLink())fail('RESIDENT_DIR_NOT_FOUND');
  const seen=new Set();
  const files=[];
  let totalBytes=0;
  function walk(relative='') {
    const dir=join(residentDir,relative);
    for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=relative?relative+'/'+item.name:item.name;
      if(item.isSymbolicLink())continue;
      if(item.isDirectory()&&/^(?:skills|styles(?:\/packs)?|state(?:\/blobs(?:\/[a-f\d]{2})?)?)$/i.test(path))walk(path);
      if(!item.isFile()||!allowedPath(path))continue;
      if(seen.has(path.toLowerCase())||files.length>=MAX_FILES)fail('CAPSULE_FILE_LIMIT');
      seen.add(path.toLowerCase());
      const full=join(residentDir,path);
      if(path!=='subject.sqlite'&&lstatSync(full).size>MAX_BYTES-totalBytes)fail('CAPSULE_SIZE_LIMIT_EXCEEDED');
      let data=path==='subject.sqlite'?snapshotDatabase(full):readFileSync(full);
      if(path==='settings.json')data=readSettings(data);
      totalBytes+=data.length;
      if(totalBytes>MAX_BYTES)fail('CAPSULE_SIZE_LIMIT_EXCEEDED');
      files.push({path,bytes:data.length,dataBase64:data.toString('base64')});
    }
  }
  walk();
  return {files,totalBytes};
}

function checkPassphrase(passphrase) {
  if(typeof passphrase!=='string'||passphrase.length<6)fail('PASSPHRASE_TOO_SHORT');
  if(Buffer.byteLength(passphrase)>1024)fail('PASSPHRASE_TOO_LONG');
}

export function createEncryptedCapsule({residentDir, residentName='Threadline', passphrase} = {}) {
  if(!residentDir||!existsSync(residentDir))fail('RESIDENT_DIR_NOT_FOUND');
  checkPassphrase(passphrase);
  const {files,totalBytes}=collectResidentFiles(residentDir);
  const createdAt=Date.now();
  const payload=Buffer.from(JSON.stringify({format:CAPSULE_FORMAT,residentName,createdAt,files}));
  if(payload.length>MAX_CONTENT)fail('CAPSULE_SIZE_LIMIT_EXCEEDED');
  const compressed=gzipSync(payload,{level:6});
  const salt=randomBytes(16),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',scryptSync(passphrase,salt,32),iv);
  const ciphertext=Buffer.concat([cipher.update(compressed),cipher.final()]);
  return {format:CAPSULE_FORMAT,alg:CAPSULE_ALG,createdAt,fileCount:files.length,rawBytes:totalBytes,
    salt:salt.toString('base64'),iv:iv.toString('base64'),authTag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}

function decode(value,maxBytes) {
  if(typeof value!=='string'||value.length>4*Math.ceil(maxBytes/3))fail('INVALID_CAPSULE_DATA');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length>maxBytes||bytes.toString('base64')!==value)fail('INVALID_CAPSULE_DATA');
  return bytes;
}

export function restoreEncryptedCapsule({capsule,targetDir,passphrase} = {}) {
  if(!capsule||capsule.format!==CAPSULE_FORMAT||capsule.alg!==CAPSULE_ALG)fail('INVALID_CAPSULE_FORMAT');
  checkPassphrase(passphrase);
  if(!targetDir)fail('TARGET_DIR_REQUIRED');
  const salt=decode(capsule.salt,16),iv=decode(capsule.iv,12),tag=decode(capsule.authTag,16),ciphertext=decode(capsule.ciphertext,MAX_CONTENT);
  if(salt.length!==16||iv.length!==12||tag.length!==16)fail('INVALID_CAPSULE_DATA');
  let payload;
  try {
    const decipher=createDecipheriv('aes-256-gcm',scryptSync(passphrase,salt,32),iv);
    decipher.setAuthTag(tag);
    const compressed=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    payload=JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_CONTENT}).toString('utf8'));
  } catch { fail('CAPSULE_DECRYPT_FAILED'); }
  if(payload?.format!==CAPSULE_FORMAT||!Array.isArray(payload.files)||payload.files.length>MAX_FILES)fail('INVALID_CAPSULE_PAYLOAD');

  const seen=new Set();
  let rawBytes=0;
  const files=payload.files.map(file=>{
    if(!allowedPath(file?.path)||seen.has(file.path.toLowerCase()))fail('UNSAFE_CAPSULE_PATH');
    seen.add(file.path.toLowerCase());
    const bytes=decode(file.dataBase64,MAX_BYTES-rawBytes);
    if(bytes.length!==file.bytes)fail('INVALID_CAPSULE_DATA');
    rawBytes+=bytes.length;
    return {path:file.path,bytes:file.path==='settings.json'?readSettings(bytes):bytes};
  });
  if(existsSync(targetDir))fail('CAPSULE_TARGET_EXISTS');
  mkdirSync(targetDir,{mode:0o700}); // Exclusive creation and no overwrite of existing data.
  for(const file of files) {
    const dest=join(targetDir,file.path);
    mkdirSync(dirname(dest),{recursive:true,mode:0o700});
    writeFileSync(dest,file.bytes,{flag:'wx',mode:0o600});
  }
  return {ok:true,residentName:payload.residentName,createdAt:payload.createdAt,restoredFiles:files.length,rawBytes};
}


// Local zero-cost Weekly Dream Digest generator (reads notes/states/events from the past N days).
export function buildWeeklyDreamDigest({
  residentName = 'Threadline',
  notes = [],
  states = [],
  events = [],
  days = 7,
  now = Date.now(),
  timezoneMinutes = 480,
} = {}) {
  const cutoff = now - days * 24 * 3600 * 1000;
  const dated=(items,date)=>items.map(item=>({item,at:date(item)}))
    .filter(r=>Number.isFinite(r.at)&&r.at>=cutoff&&r.at<=now).sort((a,b)=>b.at-a.at).map(r=>r.item);
  const recentNotes=dated(notes,n=>n.updatedAt??n.recordedAt);
  const recentStates=dated(states,s=>s.updatedAt??s.asOf??s.recordedAt);
  const recentEvents=dated(events,e=>e.occurredAt??e.recordedAt);

  const lateNightCount = recentEvents.filter(e => {
    const h = new Date((e.occurredAt??e.recordedAt)+timezoneMinutes*60000).getUTCHours();
    return h >= 0 && h < 5;
  }).length;

  const highlights = [
    ...recentStates.slice(0, 3).map(s => ({
      type: 'personal_state',
      id: s.id ?? null,
      kind: s.kind ?? 'impression',
      text: String(s.body ?? s.text ?? '').slice(0, 120),
    })),
    ...recentNotes.slice(0, 4).map(n => ({
      type: 'note',
      id: n.id ?? null,
      kind: n.kind ?? 'memory',
      text: String(n.body ?? n.text ?? '').slice(0, 120),
    })),
  ].filter(h => h.text);

  const lines = [];
  lines.push(`这 ${days} 天里，我们一共留下了 ${recentEvents.length} 条互动足迹，${residentName} 新记住了 ${recentNotes.length} 条档案、更新了 ${recentStates.length} 条主观印象。`);
  if (lateNightCount >= 2) {
    lines.push(`注意到这周你有 ${lateNightCount} 次在凌晨还在忙或找我聊天，记得照顾好作息呀。`);
  }
  if (highlights.length) {
    lines.push(`最鲜活的几条记忆火花已经列在下面——如果有我记偏的地方，直接点进去温柔修正就好。`);
  } else {
    lines.push(`这周我们聊得还比较轻，下周有新经历时，手记会继续收录。`);
  }

  return {
    format: 'threadline-dream-digest-v1',
    residentName,
    periodDays: days,
    generatedAt: now,
    stats: {
      interactions: recentEvents.length,
      newNotes: recentNotes.length,
      updatedStates: recentStates.length,
      lateNightInteractions: lateNightCount,
    },
    narrative: lines.join('\n'),
    highlights,
  };
}
