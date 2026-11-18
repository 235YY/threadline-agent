// Timing of one group-turn preparation on a large synthetic store.
//   node experiments/naturalness/bench.mjs <dbFile> [events=20000]
import {existsSync} from 'node:fs';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {socialProjection} from '../../src/social-projection.mjs';
import {recentContext} from '../../src/recent-context.mjs';
import {ensurePerson} from '../../src/identity.mjs';
import {put,event,frame,ref} from '../../test/helpers.mjs';
const [file,nArg='20000']=process.argv.slice(2),N=Number(nArg),fresh=!existsSync(file);
const store=new ContinuityStore(file),session=new ContinuitySession({store,subjectId:'jingyang',attention:true});
const people=Array.from({length:40},(_,i)=>({system:'qq',id:String(20000+i),name:'朋友'+i}));
const scenes=['qq/group/555','qq/group/666',...people.slice(0,10).map(p=>'qq/private/'+p.id)];
let t0=Date.now(),clock=1_800_000_000_000;
if(fresh){
  const senders=people.map(p=>{const s=ensurePerson(store,p);delete s.nickname;return s;});
  for(let i=0;i<N;i+=100){const commands=[];for(let j=i;j<Math.min(N,i+100);j++){const sender=senders[j%senders.length],scene=scenes[j%scenes.length];
    commands.push(event('e'+j,{body:'消息 '+j+' 关于 '+(j%7===0?'港口':'厨房'),scene,actor:sender.entityId,sender,occurredAt:clock-(N-j)*60_000,source:{system:'qq',key:'e'+j}}));}
    store.execute({requestId:'bulk'+i,commands});}
  put(store,'ws',frame({id:'ws-g',scene:'qq/group/555'}));
  console.log('seeded',N,'events in',Date.now()-t0,'ms');
}
const sender=(()=>{const s=ensurePerson(store,people[3]);delete s.nickname;return s;})();
const cur=put(store,'cur'+Date.now(),event('cur'+Date.now(),{body:'@鲸漾 在吗',scene:'qq/group/555',actor:sender.entityId,sender,occurredAt:clock,source:{system:'qq',key:'cur'+Date.now()}})).at(-1);
const ws=store.read('ws-g');
const time=(label,fn)=>{const t=performance.now();const r=fn();console.log(label.padEnd(18),(performance.now()-t).toFixed(0)+'ms');return r;};
time('recentContext',()=>recentContext({store,subjectId:'jingyang',currentEvent:cur,scene:cur.scene,limit:50}));
time('socialProjection',()=>socialProjection({store,subjectId:'jingyang',currentEvent:cur,attentionFrame:null,now:clock}));
time('prepare (full)',()=>session.prepare({currentEvent:ref(cur),workspace:ref(ws),identity:'你是鲸漾。',mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,taskThreads:true,subjectiveMemoryV2:true,socialContext:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:[],budgetBytes:131072,now:clock}));
store.close();
