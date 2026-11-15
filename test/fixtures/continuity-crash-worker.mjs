// A disposable child process against the test-created temp database only.
import {ContinuityStore} from '../../src/store.mjs';
import {initializeSubject,admitSubjectEvent} from '../../src/continuity.mjs';
import {prepareDecision,commitDecision} from '../../src/cognition.mjs';
const store=new ContinuityStore(process.argv[2],{clock:()=>2000});
initializeSubject({store,subjectId:'jingyang',requestId:'init'});
store.execute({requestId:'setup',commands:[
  {op:'append_event',id:'o1',body:'合成来信',origin:'reported',source:{system:'crash-fixture',key:'o1'},actor:'fixture',scene:'test'},
  {op:'set_workspace',id:'w1',expectedRevision:0,scene:'test',focus:{id:'current',label:'测试'}}
]});
admitSubjectEvent({store,subjectId:'jingyang',event:{id:'o1',revision:1},requestId:'admit'});
const packet=prepareDecision({store,subjectId:'jingyang',currentEvent:{id:'o1',revision:1},workspace:{id:'w1',revision:1},budgetBytes:24000});
commitDecision({store,packet,requestId:'crash-commit',decisionId:'crash-decision',output:{packetId:packet.packetId,options:[{id:'a',kind:'respond',payload:{text:'稍后继续'}}],selected:'a',summary:'合成异常退出测试',used:[],
  continuity:{changes:[{id:'crash-state',expectedRevision:0,kind:'intention',body:'已经提交，等待下轮继续',nature:'self-report',reason:'合成夹具',basis:null}],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled'}}});
// No close(), normal sender, or cleanup; parent verifies recovery and removes only its temp files.
process.exit(29);
