// Isolated adversarial internal test. Synthetic tester only; no real identity, QQ, or production DB.
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBrainService} from '../brain-service/server.mjs';
import {keepAttention} from '../../src/attention.mjs';

const at=new Date().toISOString().replace(/[:.]/g,'-');
const out=join('_local','acceptance',`internal-adversarial-${at}.json`);
const baseDir=mkdtempSync(join(tmpdir(),'jingyang-adversarial-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const attention={...keepAttention(),focus:{select:[]}};
const cont=extra=>({changes:[],residency:{add:[],remove:[]},expressionChoice:{mode:'direct',reason:null},observationDisposition:'handled',attention:{...attention,...extra}});
const reply=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'收到：'+String(packet.payload.current?.body??'').slice(0,32)}}],selected:'r',summary:'合成测试回复',used:[],continuity:cont()});
const wait=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{mode:'next-event'}}],selected:'w',summary:'先等等',used:[],continuity:cont()});
const continueOut=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'c',kind:'continue',payload:{intent:'继续刚才的事情'}}],selected:'c',summary:'继续',used:[],continuity:cont()});
const missingNature=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'格式错误',used:[],continuity:{...cont(),changes:[{id:'state:test:missing-nature',expectedRevision:0,kind:'appraisal',body:'测试状态'}]}});
const extraAttention=packet=>JSON.stringify({packetId:packet.packetId,options:[{id:'r',kind:'respond',payload:{text:'多字段回复'}}],selected:'r',summary:'多字段',used:[],continuity:cont({select:null})});
const empty=()=> '';

async function open(decide){
  const dir=mkdtempSync(join(baseDir,'svc-'));
  const sent=[];
  const service=await startBrainService({storePath:join(dir,'subject.sqlite'),stateDirectory:join(dir,'state'),global:true,heartbeatMs:0,rhythm:{minGapMs:1},decide,adapter:{send:async x=>{sent.push(x);return {delivered:true};}}});
  return {service,sent,dir};
}
async function close(x){try{x.service.close();}catch{}try{await new Promise(r=>x.service.server.close(r));}catch{}try{rmSync(x.dir,{recursive:true,force:true});}catch{}}
async function say(service,id,text){
  try{const r=await service.reply({protocol:'jingyang-brain-bridge-v1',key:'private:9000001',scene:'qq/private/9000001',message_id:id,messages:[{role:'user',content:text}],sender:{system:'qq',id:'9000001',name:'测试者A',isOwner:false}});return {ok:r.ok,error:r.error??null,text:r.text??'',silent:r.silent??null,busy:r.busy??false,deferred:r.deferred??false};}
  catch(error){return {ok:false,error:error.code??'THROW',message:error.message};}
}

const results=[];
const persona=['在吗','今天有点累，不太想说话','你还记得上次那个巡检吗','办公室门开了，你进去看了吗','里面有什么','你更喜欢办公室还是这里','如果我不理你，你会做什么','你会自己找事做吗','那你去吧','我回来了','你刚才在干嘛','算了，晚安'];
let x=await open(packet=>reply(packet));
try{
  for(let i=0;i<persona.length;i++){
    const r=await say(x.service,i+1,persona[i]);
    const h=x.service.health();
    results.push({kind:'natural',i:i+1,input:persona[i],reply:r,pending:h.pending.length,busy:h.cognitionBusy,sent:x.sent.slice(-1)[0]??null});
    if(h.pending.length)break;
    await sleep(20);
  }
}finally{await close(x);}

for(const [name,decide] of [['missing-nature',missingNature],['extra-attention',extraAttention],['empty-provider',empty],['bare-continue',continueOut]]){
  x=await open(decide);
  try{
    const r=await say(x.service,1,'测试格式和空返回');
    const h=x.service.health();
    results.push({kind:'injected',name,input:'测试格式和空返回',reply:r,pending:h.pending.length,busy:h.cognitionBusy,error:h.recovery?.modelTurns?.[0]?.error??null});
  }finally{await close(x);}
}

mkdirSync(join('_local','acceptance'),{recursive:true});
const summary={
  format:'jingyang-internal-adversarial-v1',at,identity:'synthetic-tester-A',
  natural:{turns:results.filter(r=>r.kind==='natural').length,unanswered:results.filter(r=>r.kind==='natural'&&!r.reply?.text&&r.reply?.ok).length,errors:results.filter(r=>r.kind==='natural'&&!r.reply?.ok).length,pending:results.some(r=>r.kind==='natural'&&r.pending>0)},
  injected:results.filter(r=>r.kind==='injected').map(r=>({name:r.name,ok:r.reply.ok,error:r.reply.error??r.error,pending:r.pending})),
  results
};
writeFileSync(out,JSON.stringify(summary,null,2));
console.log(JSON.stringify({out,natural:summary.natural,injected:summary.injected},null,2));
