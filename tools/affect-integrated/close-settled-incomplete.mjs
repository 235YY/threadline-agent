import {ContinuityStore} from '../../src/store.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
if(process.argv[2]!=='--apply')throw Error('explicit reviewed --apply required');
const p=JSON.parse(readFileSync('_local/ops/affect-active.json')),ledger=JSON.parse(readFileSync(p.ledgerPath));
const store=new ContinuityStore(p.storePath);
try{const results=[];for(const turn of store.all('affect_turn')){
 if(turn.status!=='uncertain'||turn.error!=='MODEL_INCOMPLETE')continue;
 const row=ledger.requests.find(r=>r.id==='turn:'+turn.packet.packetId);
 if(row?.status!=='settled'||!Number.isSafeInteger(row.actualMicros)||turn.rawOutput!==null)throw Error('NO_CONCLUSIVE_SETTLEMENT');
 if([...store.all('decision')].some(d=>d.input?.packetId===turn.packet.packetId))throw Error('DECISION_ALREADY_EXISTS');
 const evidence={turnId:turn.id,packetId:turn.packet.packetId,ledgerRow:row,reason:'known settled; no admissible complete output and no business decision; exclude only this source from automatic retry',providerFinishReason:'not-recorded-in-original-live-client'};
 const bytes=JSON.stringify(evidence,null,2),evidenceHash=createHash('sha256').update(bytes).digest('hex'),dir=join(p.backupDirectory,'incomplete-recovery');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,turn.packet.packetId+'.json'),bytes);
 const result=store.execute({requestId:'close-settled-incomplete:'+turn.packet.packetId,commands:[{op:'affect_turn',id:turn.id,expectedRevision:turn.revision,status:'closed-incomplete',resolution:{requestId:row.id,ledgerStatus:'settled',actualMicros:row.actualMicros,evidenceHash}}]}).at(-1);results.push({id:result.id,status:result.status});
 }console.log(JSON.stringify({closed:results,resent:0,historyRetained:true}));}finally{store.close();}
