// 记忆线的对象维度：anchor 只标记“这条认识主要关于谁/什么”，不是副本。
import {ensure,refKey,text} from './contracts.mjs';

export const ANCHOR_KINDS=['self','entity','scene','process'];
const exact=(x,keys,name)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k)),'ANCHOR_SHAPE',`${name} has unsupported fields`);
export function normalizeAnchor(value){
  if(value===null||value===undefined)return null;
  exact(value,['kind','id'],'anchor');
  ensure(ANCHOR_KINDS.includes(value.kind),'ANCHOR_KIND','unsupported anchor kind');
  text(value.id,'anchor id');
  ensure([...value.id].length<=200,'ANCHOR_LIMIT','anchor id too long');
  return {kind:value.kind,id:value.id};
}
export function anchorKey(value){const a=normalizeAnchor(value);return a?`${a.kind}:${a.id}`:null;}
export function sameAnchor(a,b){return anchorKey(a)===anchorKey(b);}

// 读取：只按 anchor 取已持久化的 BCRZ/笔记；不写、不推断新意义。
// legacy 保留旧正文行为；directory 只给固定版本目录，不交付正文。
const DOMAIN_VALUES=['self','relationship','world','normative'];
function domainFilter(value){
  if(value===null||value===undefined)return null;
  ensure(Array.isArray(value)&&value.length<=4,'ANCHOR_FILTER','domains filter must be bounded');
  for(const d of value)ensure(DOMAIN_VALUES.includes(d),'ANCHOR_FILTER','invalid domain');
  return [...new Set(value)];
}
function noteScopeApplies(note,currentEvent,now){
  const scope=note.scope;
  if(!scope)return true;
  if(Array.isArray(scope.scenes)&&scope.scenes.length&&currentEvent?.scene&&!scope.scenes.includes(currentEvent.scene))return false;
  if(scope.validFrom!==null&&scope.validFrom!==undefined&&now<scope.validFrom)return false;
  if(scope.validUntil!==null&&scope.validUntil!==undefined&&now>=scope.validUntil)return false;
  return true;
}
function historicalStatus(type,status){return type==='personal_state'?status!=='open':status!=='current';}
export function anchorView({store,subjectId,currentEvent=null,limit=8,mode='legacy',domains=null,about=null,includeHistorical=false,includeImpressions=false,onlyImpressions=false,now=null}={}){
  ensure(['legacy','directory'].includes(mode),'ANCHOR_MODE','unknown anchor view mode');
  ensure(!onlyImpressions||mode==='directory','ANCHOR_MODE','impression directory requires directory mode');
  const anchors=[{kind:'self',id:subjectId}];
  if(currentEvent?.scene)anchors.push({kind:'scene',id:currentEvent.scene});
  if(currentEvent?.sender?.entityId)anchors.push({kind:'entity',id:currentEvent.sender.entityId});
  else if(currentEvent?.actor){
    const actor=String(currentEvent.actor);
    const entity=[...store.all('entity')].find(e=>e.id===actor||e.name===actor||(e.aliases??[]).includes(actor));
    if(entity)anchors.push({kind:'entity',id:entity.id});
  }
  const wanted=new Set(anchors.map(anchorKey));
  const wantedDomains=domainFilter(domains);
  const wantedAbout=about===null||about===undefined?null:new Set(about.map(r=>`${r.kind}:${r.id}`));
  const clock=now??store.clockNow?.()??Date.now();
  const values=[];
  for(const type of ['personal_state','note']){
    for(const record of store.all(type)){
      if(type==='personal_state'&&record.subject!==subjectId)continue;
      if(type==='personal_state'&&record.kind==='impression'&&!(mode==='directory'&&includeImpressions))continue;
      if(onlyImpressions&&!(type==='personal_state'&&record.kind==='impression'))continue;
      const key=anchorKey(record.anchor);
      const recordAbout=Array.isArray(record.about)?record.about:(record.anchor?[record.anchor]:[]);
      const aboutHit=wantedAbout===null?true:recordAbout.some(r=>wantedAbout.has(`${r.kind}:${r.id}`));
      if(mode==='directory'&&wantedAbout!==null){if(!aboutHit)continue;}
      else if(!key||!wanted.has(key))continue;
      const historical=historicalStatus(type,record.status)||record.kind==='impression';
      if(mode==='directory'&&!includeHistorical&&historical)continue;
      if(mode==='directory'&&type==='note'&&!noteScopeApplies(record,currentEvent,clock))continue;
      if(mode==='directory'&&wantedDomains?.length){
        const recordDomains=Array.isArray(record.domains)?record.domains:[];
        if(!recordDomains.some(d=>wantedDomains.includes(d)))continue;
      }
      if(mode==='legacy'){
        values.push({ref:{id:record.id,revision:record.revision},type,anchor:record.anchor,role:record.mind?.role??null,
          body:String(record.body??'').slice(0,1200),kind:record.kind??null,status:record.status??null,asOf:record.recordedAt??null});
      }else{
        values.push({ref:{id:record.id,revision:record.revision},recordType:type,role:record.mind?.role??null,
          domains:Array.isArray(record.domains)?record.domains:[],kind:record.kind??null,status:record.status??null,
          stage:record.stage??null,anchor:record.anchor??null,about:Array.isArray(record.about)?record.about:[],asOf:record.recordedAt??null,bodyAvailable:false,historical});
      }
    }
  }
  values.sort((a,b)=>(b.asOf??0)-(a.asOf??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  const page=values.slice(0,Math.max(1,Math.min(mode==='directory'?64:32,limit)));
  if(mode==='directory')return {format:'anchor-directory-v1',anchors,records:page,omitted:Math.max(0,values.length-page.length),
    scope:'explicit-anchor-directory-only',bodyPolicy:'no-body-before-explicit-selection',
    meaning:'fixed-version-directory-not-recommendation; body-not-delivered'};
  return {format:'anchor-view-v1',anchors,records:page,scope:'explicit-anchor-records-only'};
}
export function queryAnchor({store,subjectId,anchor,role=null,limit=12}={}){
  const key=anchorKey(anchor);ensure(key,'ANCHOR_REQUIRED','anchor required');
  const roleMap={B:['belief','expectation'],C:['concern'],R:['condition'],Z:['readiness']};
  const allowed=role?new Set(roleMap[role]??[role]):null;
  const rows=[];
  for(const type of ['personal_state','note']){
    for(const record of store.all(type)){
      if(type==='personal_state'&&record.subject!==subjectId)continue;
      // anchor_recall is a BCRZ/note directory, not a short-term impression body path.
      if(type==='personal_state'&&record.kind==='impression')continue;
      if(anchorKey(record.anchor)!==key)continue;
      if(allowed&&!allowed.has(record.mind?.role))continue;
      rows.push({ref:{id:record.id,revision:record.revision},type,anchor:record.anchor,role:record.mind?.role??null,
        body:record.body,kind:record.kind??null,status:record.status??null,asOf:record.recordedAt??null});
    }
  }
  rows.sort((a,b)=>(b.asOf??0)-(a.asOf??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  return {format:'anchor-query-v1',anchor:{kind:anchor.kind,id:anchor.id},role,count:rows.length,records:rows.slice(0,Math.max(1,Math.min(32,limit)))};
}
