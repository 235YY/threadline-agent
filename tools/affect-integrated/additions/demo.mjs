import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createAffectBrain} from './service.mjs';
import {motivationId} from '../../src/affect-contract.mjs';
import {keepAttention} from '../../src/attention.mjs';

export async function runDemo(directory=mkdtempSync(join(tmpdir(),'jingyang-affect-demo-'))){
 let now=1794400000000;const trace=[];const path=join(directory,'subject.sqlite');
 const decide=packet=>{
  const input=packet.payload.continuity.motivation;
  const value={packetId:packet.packetId,options:[{id:'reply',kind:'respond',payload:{text:'【离线脚本】已收到本轮材料，当前情感投影已交付。'}}],selected:'reply',summary:'合成规则输出，用于验接线，不代表真实模型能力',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()}};
  if(input.canAppraiseCurrent)value.affectAppraisal={source_refs:[{id:packet.payload.current.id,revision:packet.payload.current.revision}],appraisals:[{weight:1,value:{event:'progress',summary:'合成任务进展',valence:.7,intensity:.6,relevance:.8,agency:'self',competence:.7}}]};
  trace.push({round:trace.length+1,input,publicOutput:value});return value;
 };
 const open=()=>createAffectBrain({storePath:path,subjectId:'synthetic-subject',identity:'离线合成主体',decide,clock:()=>now,affect:{clock:()=>now},rhythm:{dailyCallCap:20}});
 let brain=open();
 try{for(let i=0;i<3;i++){
  if(i===2){brain.close();brain=open();}
  now+=3600000;
  const result=await brain.reply({scene:'fixture/private/ann',source:'fixture',key:'fixture-ann',message_id:String(i),text:['研究完成了第一步','又完成了一步，继续理解先前的结果','重启后接着做'][i],execute:false});
  if(!result.ok||!result.text)throw Error('DEMO_INCOMPLETE:'+JSON.stringify(result));
  const saved=brain.store.read(motivationId('synthetic-subject'));Object.assign(trace.at(-1),{savedRef:{id:saved.id,revision:saved.revision},savedProjection:{drives:saved.snapshot.engineState.drives,mood:saved.snapshot.engineState.mood},reply:result,restarted:i===2});
 }}finally{brain.close();}
 const report={synthetic:true,realModelCalls:0,qqConnections:0,storePath:path,rounds:trace,claim:'已验证完整服务入口、状态交付和跨重启保存；未验证真实模型理解、心理真实性或行动收益。'};
 writeFileSync(join(directory,'demo.json'),JSON.stringify(report,null,2));
 const esc=x=>JSON.stringify(x,null,2).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 writeFileSync(join(directory,'index.html'),`<!doctype html><meta charset="utf-8"><title>情感集成版：离线三轮流水</title><style>body{max-width:960px;margin:40px auto;background:#f5f5f4;color:#222;font:17px/1.65 system-ui}section{background:white;padding:24px;margin:20px 0;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}h1{font-size:28px}</style><h1>情感集成版：离线三轮流水</h1><p>全部是人工脚本输出。真实模型调用0次，QQ连接0次。第3轮关闭并重新打开主体库。</p>${trace.map(t=>`<section><h2>第${t.round}轮${t.restarted?' · 重启接续':''}</h2><p>读取内部状态版本 ${t.input.ref.revision} → 交付本轮评价 → 引擎计算 → 同事务保存版本 ${t.savedRef.revision}。回复仍在待发送队列，未联系外部。</p><details><summary>实际输入投影</summary><pre>${esc(t.input)}</pre></details><details><summary>脚本公开输出（非真实思考）</summary><pre>${esc(t.publicOutput)}</pre></details><details><summary>保存后的内部状态</summary><pre>${esc(t.savedProjection)}</pre></details></section>`).join('')}<p>${report.claim}</p>`);
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=await runDemo(process.argv[2]);console.log(JSON.stringify({directory:resolve(r.storePath,'..'),rounds:r.rounds.length,realModelCalls:r.realModelCalls}));}
