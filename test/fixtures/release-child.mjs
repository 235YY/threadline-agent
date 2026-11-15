import {startBrainService} from '../../tools/brain-service/server.mjs';
import {launchBrain} from '../../tools/brain-service/bootstrap.mjs';
import {join} from 'node:path';
const [mode,path,id]=process.argv.slice(2);
if(mode==='lease'){
  const service=await startBrainService({port:0,storePath:path,heartbeatMs:0,global:true,subjectTask:true,decide:async p=>{
    process.send({type:'model'});await new Promise(r=>setTimeout(r,200));return {packetId:p.packetId,options:[{id:'done',kind:'act',payload:{tool:'task_finish',args:{result:'one owner'}}}],selected:'done',summary:'跨进程合成决定',used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:{processes:[],relations:[],residency:{upsert:[],remove:[]},questions:[]}}};
  }});
  process.send({type:'ready'});process.once('message',async()=>{try{process.send({type:'result',result:await service.stepAgentTask(id)});}catch(e){process.send({type:'error',code:e.code??e.message});}finally{await new Promise(r=>service.server.close(r));service.close();process.disconnect();}});
}else if(mode==='brain'){
  const running=await launchBrain({root:process.cwd(),env:{BRAIN_LIVE:'0',BRAIN_PORT:'0',BRAIN_HEARTBEAT_MS:'0',BRAIN_STORE:join(path,'brain.sqlite'),BRAIN_STATE:join(path,'state'),BRAIN_STYLE_DIR:join(path,'style'),BRAIN_IDENTITY_FILE:join(path,'identity.txt'),JY_AFFECT:'0',JY_AFFECT_FUSION:'0'},dependencies:{onStopped:()=>process.exit(0)}});
  process.send({type:'ready',url:running.service.url});
}
