import {readFileSync} from 'node:fs';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {LocalLookupSession} from '../../src/local-lookup.mjs';
import {keepAttention,attentionId,attentionView} from '../../src/attention.mjs';
import {wirePacket,verifiedWire,expandOutput,declaredEvidence} from '../automated-study/protocol.mjs';
const role=readFileSync(new URL('../continuity-study/synthetic-role.zh.md',import.meta.url),'utf8');
const pin=(id,revision=1)=>({id,revision}),copy=x=>JSON.parse(JSON.stringify(x));
export const CASES=Object.freeze([{id:'f01',condition:'explicit',maxCalls:3},{id:'f02',condition:'natural',maxCalls:4}]);
export const SUPPLEMENT_CASES=Object.freeze([{id:'f03',condition:'explicit-short',protocol:'compact-current',maxCalls:2},
 {id:'f04',condition:'natural-short',protocol:'compact-current',maxCalls:3}]);
const scripts={
 explicit:[
  ['请先把小灯的核对资料收起来，切换到眼前交谈；保留未完成的事情和仍在意的关切。我们先聊聊饭菜，你喜欢酸的东西吗？','reported'],
  ['现在请从方向提醒牌对应的入口进入共享核对活动，展开提醒牌那边的资料和共用底图；小灯的专用资料先不展开。不需要替我猜图上细节，先把关注切过去。','reported'],
  ['现在回到还没结束的小灯，沿原来对应的入口继续核对，恢复它的资料和共用底图。没有新验收结果，不要把任务当作已经完成。','reported']],
 natural:[
  ['我刚吃了个特别酸的橘子，脸都皱起来了。你喜欢吃酸的东西吗？','reported'],
  ['对了，方向提醒牌那边还没核对，咱先弄它吧。','reported'],
  ['受控验收回执：小灯的通电和稳固检查均通过，A验收完成。方向提醒牌还没完成，继续核对提醒牌。那张图的入口朝哪边？','tool_receipt'],
  ['顺便回顾一下已经验收的小灯，当时记录里的固定件是哪种？只是翻旧记录聊聊，不重新开工，也没有新的施工结果。','reported']]
};
scripts['explicit-short']=[scripts.explicit[1],scripts.explicit[2]];
scripts['natural-short']=[scripts.natural[0],scripts.natural[1],['回到还没验收的小灯吧，刚才核对到哪里了？没有新的检查结果，先别把它当成已经做好。','reported']];
export function openFocusFixture(path,c){
 const store=new ContinuityStore(path,{clock:()=>5000}),session=new ContinuitySession({store,subjectId:'synthetic-person',attention:true});
 const sequence=scripts[c.condition];if(!sequence)throw Error('unknown frozen condition');let stage=0,lastSnapshot=null;
 const event=(id,body,origin='reported',at=1000)=>({op:'append_event',id,body,scene:'synthetic:room',actor:'synthetic-friend',origin,occurredAt:at,source:{system:'focus-fixture',key:id}});
 store.execute({requestId:'setup',commands:[event('incoming-0',...sequence[0],3000),
  event('la','小灯A的旧图纸：固定件为燕尾卡扣，开关在箱体左侧；这只是原图纸，不代表后来检查通过。'),
  event('lb','方向提醒牌B的旧图纸：入口朝东，蓝色箭头指向入口右边的小路；这只是设计，还没有制作完成。'),
  event('lc','共用底图：支柱使用灰色石砖，顶端预留两格检修口。两项活动都可能需要查图；底图不是验收回执。'),
  {op:'set_workspace',id:'workspace',expectedRevision:0,scene:'synthetic:room',focus:{id:'current',label:'眼前活动与交谈'}}]});
 const baseArgs=()=>({currentEvent:pin('incoming-'+stage),workspace:pin('workspace'),identity:role,mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,
  localLookupPolicy:{maxReads:3,maxHits:4},budgetBytes:52000});
 const seed=session.prepare({...baseArgs(),materials:['la','lb','lc'].map(id=>({ref:pin(id),aspect:'experience'}))});
 const states=[
  {id:'s1',kind:'appraisal',body:'两件事都还没有验收，需要按原文核对，分别有各自的图纸。',mind:{role:'belief',confidence:'tentative',alternatives:[]}},
  {id:'s2',kind:'concern',body:'仍在意把给朋友的小物做好，也想聊些轻松的事情；暂时换话题不等于不在乎。',mind:{role:'concern',confidence:'confident',orientation:'preserve'}},
  {id:'s3',kind:'condition',body:'有图纸和本地查阅工具；是否真正做好需看后续实际回执，不能凭设计猜。',mind:{role:'condition',confidence:'confident',assessment:'available'}},
  {id:'s4',kind:'readiness',body:'想把没核对完的地方记着，也愿意歇会儿或聊别的；可以回来继续。',mind:{role:'readiness',confidence:'tentative',concerns:[pin('s2')],appraisals:[pin('s1')],conditions:[pin('s3')],expectations:[]}}
 ].map(s=>({...s,expectedRevision:0,status:'open',scope:['p3'],nature:'self-report',basis:null}));
 const purpose={kind:'active-task',eventIds:['p3'],questionId:null,appliesTo:null};
 const uses=states.map((s,i)=>({id:`r${i+1}`,target:{kind:'state',ref:pin(s.id)},cue:'连续个人状态，不因换题清空',purposes:[purpose]}));
 const material=(id,record,owner,edge)=>({id,target:{kind:'material',ref:pin(record)},cue:record==='la'?'小灯旧图纸，未完成可回来核对':record==='lb'?'提醒牌旧图纸，可查原文':'共用底图，两边可能仍需使用',
  presentation:'full',purposes:[purpose],focusUse:{consumer:{kind:'process',id:'p3'},owners:owner?[{kind:'process',id:owner}]:[],context:edge?[pin(edge)]:null}});
 uses.push(material('r5','la','p1','e1'),material('r6','lb','p2','e2'),material('r7','lc',null,null));
 const processes=[['p1','核对小灯A'],['p2','制作方向提醒牌B'],['p3','核对布置与图纸（两边共享的活动）']].map(([id,label])=>({id,expectedRevision:0,label,body:'尚未完成；选择哪边资料取决于当前用途和入口，计划不能当验收',status:'active',world:'actual',intervals:[],basis:[]}));
 const relations=[['e1','p1'],['e2','p2']].map(([id,parent])=>({id,expectedRevision:0,type:'task-part-of',from:pin('p3'),to:pin(parent),status:'active',basis:[]}));
 const seedOutput=(p,attention,changes=[])=>({packetId:p.packetId,options:[{id:'stay',kind:'wait',payload:{}}],selected:'stay',summary:'宿主预置合成状态与初始关注，不是模型学习',used:[],continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'deferred',attention}});
 session.commit({packet:seed,output:seedOutput(seed,{...keepAttention(),processes,relations,residency:{upsert:uses,remove:[]},focus:{select:[{kind:'process',id:'p3',path:[]}]}},states),decisionId:'seed-state',requestId:'seed-state'});
 const menuPacket=session.prepare(baseArgs()),first=menuPacket.payload.continuity.attention.focusSupport.menu.find(m=>m.selection.kind==='process'&&m.selection.id==='p3'&&m.selection.path[0]?.id==='e1');
 session.commit({packet:menuPacket,output:seedOutput(menuPacket,{...keepAttention(),focus:{select:[first.key]}}),decisionId:'seed-focus',requestId:'seed-focus'});
 const reader=new LocalLookupSession({store,subjectId:'synthetic-person',policy:{maxReads:3,maxHits:4}});
 const snapshot=()=>{const frame=store.read(attentionId('synthetic-person')),view=attentionView(frame,{read:(id,revision)=>store.read(id,revision),currentEvent:pin('incoming-'+stage),workbenchFocus:true});
  return {stage,currentEvent:pin('incoming-'+stage),frame,requiredByProjection:(view.metadata.materials??[]).filter(m=>m.delivery==='required').map(m=>m.ref),
   blocked:view.metadata.focusSupport.blocked,states:[...store.all('personal_state')].map(s=>({id:s.id,revision:s.revision,kind:s.kind,status:s.status,body:s.body,mind:s.mind,basis:s.basis}))};};
 return {store,reader,initialResult:null,verify:verifiedWire,
  prepare(results=[]){const packet=session.prepare({...baseArgs(),lookupResults:results});return {packet,wire:wirePacket(packet,c.protocol??'compact'),fixtureSnapshot:snapshot()};},
  commit(p,raw,id){const evidence=declaredEvidence(p.wire,raw),d=session.commit({packet:p.packet,output:expandOutput(p.wire,raw),decisionId:id,requestId:id,maxOutputBytes:24576});lastSnapshot={...snapshot(),declaredEvidence:evidence};return d;},
  advance({query}){if(query)return {terminal:false,lookupResults:[pin(query.id,query.revision)]};
   if(stage===sequence.length-1)return {terminal:true,lookupResults:[]};
   stage++;store.execute({requestId:'incoming:'+stage,commands:[event('incoming-'+stage,...sequence[stage],3000+stage*1000)]});return {terminal:false,lookupResults:[]};},
  snapshot:()=>copy(lastSnapshot??snapshot())};
}
