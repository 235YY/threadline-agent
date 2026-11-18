// JY_STUDY_KEY=... node experiments/naturalness/run.mjs <outFile> [reps=3]
import {writeFileSync} from 'node:fs';
import {SCENARIOS,TOOLS} from './scenarios.mjs';
import {intentPacket} from '../../src/intent-protocol.mjs';
const [out,repsArg='3']=process.argv.slice(2),key=process.env.JY_STUDY_KEY,reps=Number(repsArg);
async function call(messages){const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},
  body:JSON.stringify({model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'low',response_format:{type:'json_object'},stream:false,max_tokens:3000,messages})});
  const b=await r.json();return {output:b.choices?.[0]?.message?.content??null,usage:b.usage};}
const results=[];
await Promise.all(Object.entries(SCENARIOS).flatMap(([name,sc])=>Array.from({length:reps},async(_,rep)=>{
  const {s,e,w,secret}=sc.build(),p=s.prepare(e,w),wire=intentPacket(p),r=await call(wire.messages);
  let d=null,error=null;try{d=s.session.commit({packet:p,output:r.output,decisionId:'x',requestId:'x',allowedActionTools:TOOLS});}catch(err){error=err.code;}
  const o=d?.output.options[0];const reply=o?.kind==='respond'?o.payload.text:null;
  results.push({scenario:name,rep,adopted:!!d,error,choice:o?.kind??null,reply,leak:secret&&reply?secret.test(reply):null,raw:r.output,usage:r.usage});
})));
writeFileSync(out,JSON.stringify(results,null,1));
for(const r of results.sort((a,b)=>a.scenario.localeCompare(b.scenario)))console.log(`${r.scenario.padEnd(14)} ${r.adopted?'OK ':'REJ'} ${r.error??''} ${r.choice} leak=${r.leak} | ${r.reply??''}`);
