import {refKey} from './contracts.mjs';
import {isGroupScene,isPrivateScene} from './social-projection.mjs';
import {sourceReplyRoute} from './reply-route.mjs';
import {SLOW_WATERMARK_ID} from './memory-gating.mjs';

export const memoryPersonKeys=event=>[...new Set([event.sender?.entityId,event.sender?.id,event.actor].filter(Boolean).map(String))];
const direct=scene=>isPrivateScene(scene)||/^local\//.test(scene??'');
const sameRecipient=(first,second)=>{
  const a=first.sender,b=second.sender;
  return Boolean(a?.system&&a?.id&&a.system===b?.system&&a.id===b.id);
};

// The subject may find material anywhere. Audience controls what can enter this
// conversation, independently of the topic, ranking score and retrieval route.
export function memoryAudience({store,event,subjectId,now}){
  const group=isGroupScene(event.scene),people=new Set(memoryPersonKeys(event));
  const cache=new Map();
  const gateway=scene=>typeof scene==='string'&&scene.startsWith('local/gateway/');
  const sameAudience=source=>source.scene===event.scene
    || !gateway(source.scene)&&!gateway(event.scene)&&(/^local\//.test(source.scene??'')&&/^local\//.test(event.scene??'')
    || direct(source.scene)&&direct(event.scene)&&sameRecipient(source,event));

  return (record,{historical=false}={})=>{
    if(!record||record.id===SLOW_WATERMARK_ID||!['note','event','personal_state'].includes(record.type))return false;
    const top=refKey(record),cacheKey=top+'#'+historical;
    if(cache.has(cacheKey))return cache.get(cacheKey);
    const pending=[record],seen=new Set();
    let authorizedGroup=!group,allowed=true;
    while(pending.length){
      const value=pending.pop(),key=refKey(value);
      if(seen.has(key))continue;
      if(seen.size>=48){allowed=false;break;}
      seen.add(key);
      if(value.type==='event'){
        let matches=sameAudience(value);
        if(!matches&&value.origin==='tool_receipt'){
          const lineage=sourceReplyRoute({read:(id,revision)=>store.read(id,revision),all:type=>store.all(type),event:{id:value.id,revision:value.revision},subjectId});
          matches=lineage.sources.some(ref=>{
            const source=store.read(ref.id,ref.revision);
            return source?.type==='event'&&['reported','observed'].includes(source.origin)&&sameAudience(source)
              &&Boolean(store.subjectObservation(subjectId,source.id));
          });
        }
        if(!matches||!store.subjectObservation(subjectId,value.id)){allowed=false;break;}
        authorizedGroup=true;
        continue;
      }
      if(value.type==='note'){
        if(value.id===SLOW_WATERMARK_ID||value.id.startsWith('note:trait:')&&store.basisChanged(value)){allowed=false;break;}
        const scope=value.scope??{},scenes=scope.scenes??[],recipients=scope.people??[];
        if(scenes.length&&!scenes.includes(event.scene)||recipients.length&&(group||!recipients.some(x=>people.has(x)))
          ||scope.validFrom!=null&&now<scope.validFrom||scope.validUntil!=null&&now>=scope.validUntil
          ||!historical&&(value.status!=='current'||store.read(value.id)?.revision!==value.revision)){allowed=false;break;}
        if(scenes.includes(event.scene))authorizedGroup=true;
      }else if(value.type==='personal_state'){
        if(value.subject!==subjectId||!historical&&(value.status!=='open'||store.read(value.id)?.revision!==value.revision)){allowed=false;break;}
      }else{allowed=false;break;}
      const refs=value.type==='note'?(value.evidence??[]):[
        ...(value.basis?.observations??[]),...(value.basis?.memories??[]),...(value.basis?.priorStates??[])];
      if(refs.length+pending.length>48){allowed=false;break;}
      for(const ref of refs){
        const source=store.read(ref.id,ref.revision);
        if(!source){allowed=false;break;}
        pending.push(source);
      }
      if(!allowed)break;
    }
    allowed&&=authorizedGroup;
    cache.set(cacheKey,allowed);
    return allowed;
  };
}
