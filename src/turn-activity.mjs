import {digest,ensure} from './contracts.mjs';

// Host recovery journal, not a subjective memory or a model-visible instruction.
export const activityId=(subject,workspace)=>`extension:${subject}:runtime:turn:${digest(workspace.id)}`;
export function readActivity(store,subject,workspace){
  const r=store.read(activityId(subject,workspace));
  if(r)ensure(r.type==='extension_record'&&r.owner===subject&&r.theory==='runtime'&&r.stateType==='turn-activity','TURN_ACTIVITY','unexpected recovery record');
  return r;
}
export function activityWrite(record,{subject,workspace,value}){
  return {op:'put_extension_record',id:activityId(subject,workspace),owner:subject,theory:'runtime',stateType:'turn-activity',schemaVersion:'1',expectedRevision:record?.revision??0,value};
}
export function saveActivity(store,record,args){
  const command=activityWrite(record,args);
  return store.execute({requestId:`runtime-turn:${command.id}:${command.expectedRevision}:${digest(command.value)}`,commands:[command]}).at(-1);
}
