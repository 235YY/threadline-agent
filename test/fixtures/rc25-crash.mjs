import {writeFileSync,appendFileSync} from 'node:fs';
import {AgentRuntime} from '../../src/agent-runtime.mjs';
const dir=process.argv[2],runtime=new AgentRuntime({checkpoint:t=>writeFileSync(dir+'/snapshot.json',JSON.stringify(t)),tools:{effect:async()=>{appendFileSync(dir+'/effects.txt','once\n');process.send({type:'effect'});await new Promise(()=>{});}}});
await runtime.executeDecision(runtime.createTask({goal:'isolated mock effect',metadata:{allowedTools:['effect']}}),{kind:'tool',tool:'effect',args:{},decisionRef:{id:'d',revision:1}});
