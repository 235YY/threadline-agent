import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {canonical,digest,ensure} from '../src/contracts.mjs';
import {failureMetadata,outputMetrics} from '../src/debug-contract.mjs';
import {DebugArchive} from '../src/debug-reader.mjs';
import {renderDebugWorkbench} from '../src/debug-view.mjs';
import {DeepSeekStudyClient,requireStudyNetwork} from './model-study/client.mjs';
import {ScaleLedger,liability} from './scale-study/ledger.mjs';
import {durableCall} from './scale-study/durable-call.mjs';
import {studyKey} from './automated-study/credential.mjs';
const files=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(d,e.name)):[join(d,e.name)]);

export function checkCaseGate(rows,gate){
 if(gate===null)return;
 ensure(Number.isSafeInteger(gate.minCommitted)&&gate.minCommitted>=1,'CASE_GATE_CONFIG','positive accepted-round gate required');
 if(rows.length===0)return;
 const prior=rows.at(-1);
 ensure(!prior.failure&&prior.rounds.length>=gate.minCommitted,'CASE_GATE','previous case did not meet the registered continuation gate');
}

// Explicit frozen experiment runner. It does not choose new cases, modify code, or expand budgets.
export async function runBoundedStudy({root,campaignName,cases,phase,ceilings,sourcePaths,sourceDirs,openFixture,ledgerOptions,pointerName='current.json',exploratorySupplement=false,caseGate=null,
 limitations=['synthetic-preseeded-history','single-pair-per-scenario','input-length-confound','host-does-not-decide-semantic-completion']}){
 const campaign=join(root,'evaluation',campaignName),paths=[...sourceDirs.flatMap(d=>files(join(root,d))),...sourcePaths.map(p=>join(root,p))];
 checkCaseGate([],caseGate);
 const design={format:'bounded-study-v1',cases,phase,exploratorySupplement,...(caseGate?{caseGate}:{}),...ceilings,sourceHashes:paths.map(p=>({path:relative(root,p),hash:digest(readFileSync(p,'utf8'))})),
  limitations};
 const plan={...design,hash:digest(design)},dir=join(campaign,plan.hash),pointer=join(campaign,pointerName),paid=process.argv.includes('--run');mkdirSync(dir,{recursive:true});
 if(paid)ensure(existsSync(pointer)&&JSON.parse(readFileSync(pointer,'utf8')).hash===plan.hash,'SOURCE_CHANGED','freeze exact plan before spending');
 if(!existsSync(join(dir,'manifest.json'))){writeFileSync(join(dir,'manifest.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  for(const h of plan.sourceHashes){const p=join(dir,'source',h.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,readFileSync(join(root,h.path)),{flag:'wx'});}}
 writeFileSync(pointer,JSON.stringify({hash:plan.hash,directory:dir},null,2)+'\n');
 if(!paid){console.log(JSON.stringify({directory:dir,cases:cases.length,requestsSent:0}));return;}
 const option=process.argv.find(x=>x.startsWith('--case-limit=')),limit=option?Number(option.split('=')[1]):cases.length;
 ensure(Number.isSafeInteger(limit)&&limit>0&&limit<=cases.length,'CASE_LIMIT','bounded case count required');
 let ledger,stop=null;const rows=[];
 try{
  await requireStudyNetwork();ledger=new ScaleLedger(join(root,'evaluation/scale-study_2026-11-03/budget.json'),{
   sourcePath:join(root,'evaluation/personality-study_2026-11-03/authorized-pilot-v1-budget.json'),...ledgerOptions});
  for(const c of cases.slice(0,limit)){
   checkCaseGate(rows,caseGate);
   const cdir=join(dir,c.id),resultPath=join(cdir,'result.json');mkdirSync(cdir,{recursive:true});
   if(existsSync(resultPath)){rows.push(JSON.parse(readFileSync(resultPath,'utf8')));continue;}
   const db=join(cdir,'core.sqlite');ensure(!existsSync(db),'INTERRUPTED_CASE','do not reset or resend partial episode');
   const f=openFixture(db,c),before=canonical([...f.store.all('note')]),rounds=[];let latest=f.initialResult?[f.initialResult]:[],failure=null,terminal=false;
   try{
    for(let i=0;i<c.maxCalls;i++){
     ensure(!existsSync(join(root,'evaluation/scale-study_2026-11-03/stop.requested')),'STOP_REQUESTED','stop before another model request');
     const p=f.prepare(latest),name='r'+i,step=join(cdir,name),id=`${phase}:${c.id}:${name}`,decisionId='decision:'+name;
     ensure(p.wire.bytes<=ceilings.maxInputBytes,'INPUT_OVERFLOW','complete actual input exceeds frozen bound');mkdirSync(step,{recursive:true});
     const context={subjectId:p.packet.payload.continuity.subject.id,packetId:p.packet.packetId,decisionId};let response=null,d=null,query=null,stepFailure=null;
     f.store.recordDiagnostic({stage:'study.wire-delivered',status:'ok',context,data:{schemaStage:p.wire.stage,bytes:p.wire.bytes,source:p.wire.packetId}});
     f.store.recordDiagnostic({stage:'model.started',status:'started',context,data:{modelCalled:true,bytes:p.wire.bytes}});
     try{
      response=await durableCall({directory:join(step,'call'),id,wire:p.wire,ledger,client:new DeepSeekStudyClient({ledger,getKey:studyKey,maxTokens:ceilings.maxTokens,inputVerifier:f.verify})});
      f.store.recordDiagnostic({stage:'model.completed',status:'completed',context,data:{...outputMetrics(response.output),durationMs:response.latencyMs}});
      d=f.commit(p,response.output,decisionId);const choice=d.output.options.find(o=>o.id===d.output.selected);
      if(choice.kind==='lookup'){query=f.reader.execute({decision:{id:d.id,revision:d.revision}});latest=[{id:query.id,revision:query.revision}];}else terminal=true;
      if(f.advance){const next=f.advance({decision:d,query});ensure(next&&typeof next.terminal==='boolean'&&Array.isArray(next.lookupResults),'EPISODE_TRANSITION','fixture transition must be explicit');terminal=next.terminal;latest=next.lookupResults;}
      rounds.push({name,kind:choice.kind,payload:choice.payload,summary:d.output.summary,used:d.output.used,
       delivered:p.packet.payload.materials.map(m=>({ref:m.ref,historical:m.historical})),progress:p.packet.payload.information?.progress??null,
       query:query?{ref:{id:query.id,revision:query.revision},requested:query.requested,outcome:query.outcome,method:query.method,readPerformed:query.readPerformed,
        remainingReads:query.remainingReads,entries:query.entries,navigation:query.consultation?.navigation??null}:null,
       inputBytes:p.wire.bytes,usage:response.usage,latencyMs:response.latencyMs,
       ...(f.snapshot?{workbench:{before:p.fixtureSnapshot,after:f.snapshot()}}:{})});
      console.log(JSON.stringify({case:c.id,round:name,kind:choice.kind,query:query?.outcome??null}));
     }catch(error){stepFailure=failureMetadata(error);const saved=join(step,'call/response.json');if(!response&&existsSync(saved))response=JSON.parse(readFileSync(saved,'utf8'));
      f.store.recordDiagnostic({stage:response?'model.output-rejected':'model.failed',status:response?'rejected':'uncertain',context,data:stepFailure});throw error;
     }finally{
      const a=new DebugArchive(db);try{const b=a.bundle({includeContent:true,selections:[{packetId:p.packet.packetId}]});
       b.study={basePacketId:p.packet.packetId,actualMessages:p.wire.messages,wireBytes:p.wire.bytes,wireIntegrity:true,finalOutput:response?.output??null,
        usage:response?.usage??null,latencyMs:response?.latencyMs??null,result:d?{decision:{id:d.id,revision:d.revision}}:null,failure:stepFailure};
       writeFileSync(join(step,'debug.json'),JSON.stringify(b,null,2)+'\n',{flag:'wx'});writeFileSync(join(step,'index.html'),renderDebugWorkbench(b),{flag:'wx'});
      }finally{a.close();}
     }
     if(terminal)break;
    }
   }catch(error){failure=failureMetadata(error);}
   finally{const row={...c,rounds,failure,terminal,caseBudgetBoundary:!failure&&!terminal,notesUnchanged:before===canonical([...f.store.all('note')]),integrity:f.store.integrity()};
    f.store.close();writeFileSync(resultPath,JSON.stringify(row,null,2)+'\n',{flag:'wx'});rows.push(row);}
   if(ledger.data.halted||failure&&['UNCERTAIN_REQUEST','CALL_LIMIT','SPEND_LIMIT','STOP_REQUESTED'].includes(failure.errorCode))throw Object.assign(new Error('uncertainty or budget stop'),{code:failure?.errorCode??'UNCERTAIN_REQUEST'});
  }
 }catch(error){stop=failureMetadata(error);process.exitCode=1;}
 finally{const own=ledger?.data.requests.filter(r=>r.id.startsWith(phase+':'))??[],report={planHash:plan.hash,rows,stop,phaseCalls:own.length,
   phaseConservativeCny:liability(own)/1e6,totalConservativeCny:ledger?liability(ledger.data.requests)/1e6:null,onlineWrites:0};
  writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');ledger?.close();console.log(JSON.stringify({directory:dir,cases:rows.length,calls:own.length,cost:report.phaseConservativeCny,stop}));}
}
