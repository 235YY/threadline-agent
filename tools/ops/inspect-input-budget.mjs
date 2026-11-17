import {readFileSync} from 'node:fs';
import {ContinuityStore} from '../../src/store.mjs';
import {prepareDecision} from '../../src/cognition.mjs';
import {CAPABILITIES} from '../../src/capabilities.mjs';
import {StyleStore} from '../../src/style-store.mjs';
import {READ_ONLY_HOST_TOOLS} from '../brain-service/server.mjs';
const active=JSON.parse(readFileSync('_local/ops/affect-active.json')),store=new ContinuityStore(active.storePath);
try{
 const excluded=new Set([...store.all('affect_turn')].filter(t=>t.status==='closed-incomplete').map(t=>t.packet.payload.current?.id));
 const next=store.subjectInbox({subjectId:'jingyang',pendingOnly:true,limit:64}).items.find(i=>!excluded.has(i.eventId));
 if(!next){console.log(JSON.stringify({pending:false,modelCalls:0}));}
 else{const event=store.read(next.eventId),w=store.read('ws:global');
 const packet=prepareDecision({store,subjectId:'jingyang',currentEvent:{id:event.id,revision:event.revision},workspace:{id:w.id,revision:w.revision},identity:readFileSync('_local/migrate/persona.txt','utf8').trim().slice(0,8000),style:new StyleStore({directory:'_local/style'}).text(),materials:[],previousDecisions:[],mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,subjectiveDomains:true,subjectiveMemoryV2:true,taskThreads:true,localLookupPolicy:{maxReads:2,maxHits:4},lookupResults:[],allowedActionTools:[...READ_ONLY_HOST_TOOLS,'start_agent_task','pause_agent_task','stop_agent_task','redirect_agent_task'],budgetBytes:131072,now:Date.now(),capabilities:CAPABILITIES.map(c=>c.id)});
 console.log(JSON.stringify({fits:true,bytes:packet.bytes,budgetBytes:packet.budgetBytes,modelCalls:0}));}
}catch(e){console.log(JSON.stringify({fits:false,code:e.code,details:e.details,modelCalls:0}));process.exitCode=1;}finally{store.close();}
