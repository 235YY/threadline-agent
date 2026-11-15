export function isClosedRejection(value){
 return value?.format==='host-processing-outcome-v1'&&value.status==='failed-not-adopted'&&value.adopted===false&&value.execution==='not-started'&&['settled','not-dispatched'].includes(value.accounting)&&typeof value.packetId==='string'&&typeof value.sourceEvent==='string'&&typeof value.closure?.id==='string'&&Number.isSafeInteger(value.closure.revision)&&value.closure.revision>0;
}
