// Real-model comparison: full decision protocol vs intent-v1 on identical base packets.
//   JY_STUDY_KEY=sk-... node experiments/intent-study/run.mjs <outDir> [reps=3] [maxYuan=8]
// The key is read from the environment only and never written. Same request settings as
// production (deepseek-flash, thinking low, JSON mode, max_tokens 3000, one format repair).
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {SCENARIOS,TOOLS} from './scenarios.mjs';
import {intentPacket,intentFormatIssue} from '../../src/intent-protocol.mjs';
import {proposalFormatIssue} from '../../src/model-output-recovery.mjs';

const [outDir,repsArg='3',capArg='8',armsArg='full,intent']=process.argv.slice(2);const ARMS=armsArg.split(',');
const key=process.env.JY_STUDY_KEY;if(!outDir||!key)throw Error('usage: JY_STUDY_KEY=... node run.mjs <outDir> [reps] [maxYuan]');
const reps=Number(repsArg),cap=Number(capArg);mkdirSync(outDir,{recursive:true});
// Pessimistic price ceiling for the spend guard (CNY per million tokens); real spend is read from the balance API.
const PRICE={input:4,output:16};
let spentEstimate=0;
const balance=async()=>{const r=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:'Bearer '+key}});const j=await r.json();return Number(j.balance_infos?.find(b=>b.currency==='CNY')?.total_balance);};
async function call(messages){
  if(spentEstimate>=cap)throw Object.assign(Error('spend cap reached'),{code:'CAP'});
  const t0=Date.now();
  const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},
    body:JSON.stringify({model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'low',response_format:{type:'json_object'},stream:false,max_tokens:3000,messages}),signal:AbortSignal.timeout(180000)});
  const body=await r.json();
  const u=body.usage??{};spentEstimate+=(u.prompt_tokens??0)/1e6*PRICE.input+(u.completion_tokens??0)/1e6*PRICE.output;
  return {status:r.status,output:body.choices?.[0]?.message?.content??null,finish:body.choices?.[0]?.finish_reason??null,usage:u,ms:Date.now()-t0,error:r.ok?null:body};
}
const FEEDBACK=issue=>JSON.stringify({kind:'host-format-feedback',issue,adopted:false,instruction:'前稿未被采用，任何查询/发送/状态修改均未执行。请重新提交完整JSON，保留packetId。只有一次自动重填机会。'});

async function runOne(name,arm,rep){
  const sc=SCENARIOS[name],s=sc.build(),p=s.prepare();
  const wire=arm==='intent'?intentPacket(p):null,messages=wire?wire.messages:p.messages;
  const issueOf=raw=>wire?intentFormatIssue(raw??'',wire):proposalFormatIssue(raw??'',p);
  const calls=[await call(messages)];let raw=calls[0].output;
  const firstIssue=issueOf(raw);
  if(firstIssue){calls.push(await call([...messages,{role:'assistant',content:raw??''},{role:'user',content:FEEDBACK(firstIssue)}]));raw=calls[1].output;}
  let decision=null,error=null;
  try{decision=s.session.commit({packet:p,output:raw,decisionId:'study',requestId:'study',allowedActionTools:TOOLS});}
  catch(e){error={code:e.code??e.name,message:String(e.message).slice(0,300)};}
  const compiled=decision?.output??null,chosen=compiled?.options.find(o=>o.id===compiled.selected)??null;
  return {scenario:name,arm,rep,inputBytes:wire?wire.bytes:p.bytes,calls:calls.map(c=>({status:c.status,finish:c.finish,usage:c.usage,ms:c.ms,error:c.error})),
    firstPassFormatOk:!firstIssue,firstIssue,adopted:!!decision,error,choice:chosen?.kind??null,
    reply:chosen?.kind==='respond'?chosen.payload.text:null,act:chosen?.kind==='act'?chosen.payload:null,lookup:chosen?.kind==='lookup'?chosen.payload:null,
    stateChanges:compiled?.continuity.changes.length??null,processOps:compiled?.continuity.attention?.processes?.length??null,
    checks:decision&&sc.check?sc.check({compiled,store:s.store,e:s.e}):null,rawOutputs:calls.map(c=>c.output)};
}

const before=await balance();console.log('balance before',before);
const results=[];
const jobs=[];for(let rep=0;rep<reps;rep++)for(const name of Object.keys(SCENARIOS))for(const arm of ARMS)jobs.push([name,arm,rep]);
let next=0;
async function worker(){while(next<jobs.length){const [n,a,r]=jobs[next++];try{const res=await runOne(n,a,r);results.push(res);
  console.log(`${n.padEnd(15)} ${a.padEnd(6)} r${r} adopted=${res.adopted} ${res.error?.code??''} choice=${res.choice} fmt1=${res.firstPassFormatOk} est¥${spentEstimate.toFixed(3)}`);}
  catch(e){if(e.code==='CAP'){console.log('cap reached');return;}results.push({scenario:n,arm:a,rep:r,crash:String(e.message)});console.log(n,a,r,'CRASH',e.message);}
  writeFileSync(join(outDir,'results.json'),JSON.stringify(results,null,1));}}
await Promise.all([worker(),worker(),worker(),worker()]);
const after=await balance();console.log('balance after',after,'spent',(before-after).toFixed(2),'estimate',spentEstimate.toFixed(3));
writeFileSync(join(outDir,'results.json'),JSON.stringify({balanceBefore:before,balanceAfter:after,estimateYuan:spentEstimate,settings:{model:'deepseek-flash',reasoning:'low',maxTokens:3000,json:true,formatRepair:1},results},null,1));
