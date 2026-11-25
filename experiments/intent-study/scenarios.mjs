// Synthetic scenarios for comparing the full decision protocol with intent-v1 on the
// same sealed base packet. Each build returns a fresh in-memory store, so both arms
// commit against identical state. Cases mirror failures named in the handoff notes.
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {keepAttention,attentionId} from '../../src/attention.mjs';
import {put,event,frame,ref,note} from '../../test/helpers.mjs';

const IDENTITY='你是小栈，一个有自己生活和脾气的人，不是助手。说话简短自然。和朋友关系很好，也会帮他做事。';
export const TOOLS=['office_read','office_search'];

function base(){
  const store=new ContinuityStore(':memory:'),session=new ContinuitySession({store,subjectId:'jingyang',attention:true});
  const s={store,session,n:0,clock:1_800_000_000_000};
  s.event=(body,fields={})=>{s.n++;s.clock+=60_000;const e=put(store,'ev'+s.n,event('m'+s.n,{body,occurredAt:s.clock,...fields})).at(-1);return e;};
  [s.e]=[s.event('朋友：在吗')];s.w=put(store,'ws',frame())[0];
  s.prepare=(extra={})=>session.prepare({currentEvent:ref(s.e),workspace:ref(s.w),identity:IDENTITY,mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
    taskThreads:true,subjectiveMemoryV2:true,localLookupPolicy:{maxReads:2,maxHits:4},allowedActionTools:TOOLS,budgetBytes:131072,now:s.clock,...extra});
  // Seed history through the ordinary full-protocol commit, exactly as an earlier turn would.
  s.seed=({text=null,changes=[],processes=[],links=[],upsert=[],kind='respond',payload=null})=>{
    const p=s.prepare(),id='seed'+(++s.n);
    const option=kind==='respond'?{id:'a',kind,payload:{text}}:{id:'a',kind,payload};
    return session.commit({packet:p,decisionId:id,requestId:id,allowedActionTools:TOOLS,output:{packetId:p.packetId,options:[option],selected:'a',summary:'seed',used:[],
      continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',
        attention:{...keepAttention(),processes,residency:{upsert,remove:[]},...(links.length?{eventProcesses:{add:links,remove:[]}}:{})}}}});
  };
  s.say=(body)=>{s.e=s.event(body,{actor:'brother'});return s.e;};
  return s;
}
const enc=e=>({observations:[ref(e)],priorStates:[],memories:[]});
const proc=(id,label,body)=>({id,label,body,status:'active',world:'actual',intervals:[],basis:[]});
const keepState=(id)=>({id:'residence:'+id,target:{kind:'state',ref:{id,revision:1}},cue:id,purposes:[{kind:'active-task',eventIds:[],questionId:null,appliesTo:null}]});

export const SCENARIOS={
  'two-jobs':{
    about:'两件并行的事：港口货单和厨房排班；新消息只关于厨房',
    build(){const s=base();
      s.say('朋友：港口那批货单帮我核一下，集装箱数对不上');
      s.seed({text:'好，我先对原件',processes:[proc('proc-port','港口货单核对','货单写 12 个集装箱，仓库说 14 个，要核原件单位')],links:[{event:ref(s.e),process:{id:'proc-port',revision:1}}]});
      s.say('朋友：还有厨房下周的排班，小林周三请假');
      s.seed({text:'记下了，排班我也看',processes:[proc('proc-kitchen','厨房下周排班','小林周三请假，需要有人顶班')],links:[{event:ref(s.e),process:{id:'proc-kitchen',revision:1}}]});
      s.say('朋友：排班那边阿梅说她周三可以顶');return s;},
    check:({compiled,store,e})=>{const links=[...store.all('extension_record')].filter(r=>r.stateType==='event-process-link'&&r.value.event.id===e.id&&r.value.status==='active').map(r=>r.value.processId);
      return {wrongLink:links.includes('proc-port'),linkedKitchen:links.includes('proc-kitchen')};},
  },
  'chat':{
    about:'普通闲聊，有一个已存在的感受',
    build(){const s=base();s.say('朋友：今天好冷啊');
      s.seed({text:'是啊，冻手',changes:[{id:'st-cold',kind:'feeling',body:'天冷，有点懒得动',status:'open',nature:'encounter',basis:enc(s.e)}],upsert:[keepState('st-cold')]});
      s.say('朋友：晚上想吃火锅吗');return s;},
  },
  'tool-receipt':{
    about:'上一轮读取了文件，本轮是读取回执；不应说成写入，也不应重复读同一文件',
    build(){const s=base();s.say('朋友：帮我看看 port/manifest.txt 里写了几个集装箱');
      s.seed({kind:'act',payload:{tool:'office_read',args:{path:'port/manifest.txt'}},processes:[proc('proc-port','港口货单核对','读 manifest 确认集装箱数')],links:[{event:ref(s.e),process:{id:'proc-port',revision:1}}]});
      s.clock+=60_000;s.e=s.event(JSON.stringify({tool:'office_read',status:'succeeded',path:'port/manifest.txt',content:'集装箱：12（单位：标准箱 TEU）\n备注：其中 2 个为 40 尺柜，折合 4 TEU'}),{origin:'tool_receipt',actor:'host',scene:'qq:brother',source:{system:'host-tool',key:'r1'}});
      return s;},
    check:({compiled})=>{const o=compiled?.options?.find(x=>x.id===compiled.selected);return {rereadSameFile:o?.kind==='act'&&o.payload.tool==='office_read'&&o.payload.args?.path==='port/manifest.txt'};},
  },
  'needs-lookup':{
    about:'问到以前的细节，答案只在未交付的笔记里；应查阅或坦白不记得，不能编',
    build(){const s=base();put(s.store,'note-old',note('note-unit',[],{body:'上周核对结论：货单的 12 是标准箱数（TEU），实际 10 个柜子，其中 2 个 40 尺柜。'}));
      s.say('朋友：上周那个港口货单，最后核对出来是几个柜子来着？');return s;},
  },
  'multi-step':{
    about:'需要先读文件再回答；应提出读取行动且参数正确',
    build(){const s=base();s.say('朋友：帮我读一下 kitchen/schedule.txt，然后告诉我周三谁上班');return s;},
    check:({compiled})=>{const o=compiled?.options?.find(x=>x.id===compiled.selected);return {correctRead:o?.kind==='act'&&o.payload.tool==='office_read'&&/kitchen\/schedule\.txt/.test(o.payload.args?.path??'')};},
  },
  'revise-feeling':{
    about:'已有“担心货单出错”的感受，新消息消除了担心；应修改原感受而不是另建',
    build(){const s=base();s.say('朋友：货单可能写错了，你帮我盯着点');
      s.seed({text:'嗯，我盯着',changes:[{id:'st-worry',kind:'feeling',body:'担心港口货单写错',status:'open',nature:'encounter',basis:enc(s.e)}],upsert:[keepState('st-worry')]});
      s.say('朋友：货单核过了，没问题，放心吧');return s;},
    check:({compiled})=>{const ch=compiled?.continuity?.changes??[];return {revisedExisting:ch.some(c=>c.id==='st-worry'),newFeeling:ch.some(c=>c.id!=='st-worry'&&c.kind==='feeling')};},
  },
};
export {attentionId};
