import {ContinuitySession} from '../../src/continuity-session.mjs';
import {LocalLookupSession} from '../../src/local-lookup.mjs';
import {keepAttention,attentionId} from '../../src/attention.mjs';

export const pin=(id,revision=1)=>({id,revision});
export const policy={maxReads:4,maxHits:8};
export const observation=(id,body)=>({op:'append_event',id,body,scene:'fixture:home',actor:'fixture-sibling',origin:'reported',
  occurredAt:1000,source:{system:'unified-graph-controlled-fixture',key:id}});
export function graphFixture(store){
  const session=new ContinuitySession({store,subjectId:'fixture-person',attention:true});
  store.execute({requestId:'fixture:start',commands:[observation('now','受控问题：接下来想怎样处理小屋？'),
    observation('source','受控记录：本来想修屋顶，但并没有开始施工；失败原因尚未查清。'),
    {op:'set_workspace',id:'workspace',expectedRevision:0,scene:'fixture:home',focus:{id:'home',label:'小屋'}},
    {op:'write_note',id:'note',expectedRevision:0,kind:'interpretation',change:'new_evidence',body:'据记录，尚不能断言屋顶已经修好。',evidence:[pin('source')]}]});
  return {store,session,o:pin('now'),w:pin('workspace'),seq:0,
    reader:new LocalLookupSession({store,subjectId:'fixture-person',policy})};
}
export function prepare(s,extra={}){return s.session.prepare({currentEvent:s.o,workspace:s.w,mind:true,unified:true,localLookupPolicy:policy,budgetBytes:131072,...extra});}
export function proposal(packet,{changes=[],attention=keepAttention(),kind='wait',payload={},used=[]}={}){
  return {packetId:packet.packetId,options:[{id:'choice',kind,payload}],selected:'choice',summary:'人工夹具验证接线；没有真实模型或游戏参与',used,
    continuity:{changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention}};
}
export function commit(s,options={},extra={}){
  const packet=extra.packet??prepare(s,extra),id=`fixture-decision:${++s.seq}`;
  return s.session.commit({packet,output:proposal(packet,options),requestId:id,decisionId:id,allowedActionTools:extra.allowedActionTools??[]});
}
export function next(s,body='受控问题：继续刚才的查阅'){
  const id=`next:${++s.seq}`;s.store.execute({requestId:id,commands:[observation(id,body)]});s.o=pin(id);return s;
}
export const trace=(route,seeds,extra={})=>({trace:{route,seeds,maxDepth:4,maxNodes:8,maxBytes:16384,includeHistorical:false,offset:0,scope:[],need:'找当前问题需要的已记录关联',...extra}});
const mind=(role,fields={})=>({role,confidence:'tentative',...fields});
const state=(id,kind,body,metadata,fields={})=>({id,expectedRevision:0,kind,body,nature:'self-report',status:'open',scope:['fixture:home'],mind:metadata,...fields});
export function seed(s,{processes=true}={}){
  const changes=[state('care','concern','仍珍惜这份小屋礼物',mind('concern',{orientation:'preserve'})),
    state('belief','appraisal','我还不知道失败原因，不等于我不会修。',mind('belief',{alternatives:['也许只是材料摆放不当']}),
      {basis:{observations:[pin('source')],memories:[pin('note')]}}),
    state('means','condition','还没有核实可用办法',mind('condition',{assessment:'unknown'})),
    state('forecast','expectation','学会支撑方法后，也许可以修好',mind('expectation',{action:{tool:'fixture.repair',args:{style:'brace'}},
      when:{all:[{condition:pin('means')},{not:{constant:false}}]},likelihood:'possible',effects:[{concern:pin('care'),relation:'supports',confidence:'tentative'}]})),
    state('readiness','readiness','想休息，也想弄明白；没有决定已经动工。',mind('readiness',{
      concerns:[pin('care')],appraisals:[pin('belief')],conditions:[pin('means')],expectations:[pin('forecast')]}))];
  const p=(id,fields={})=>({id,expectedRevision:0,label:id,body:`过程 ${id}：这是受控测试，不是她真实做过的事情。`,status:'active',world:'actual',intervals:[{start:1000,end:null}],basis:[pin('source')],...fields});
  const r=(id,from,to,type)=>({id,expectedRevision:0,type,from:pin(from),to:pin(to),status:'active',basis:[]});
  const attention={...keepAttention(),...(processes?{processes:[p('home'),p('materials'),p('possible-home',{world:'possible',status:'proposed'})],
    relations:[r('part','materials','home','task-part-of'),r('realization','home','possible-home','realizes')]}:{})};
  commit(s,{changes,attention},{materials:[{ref:pin('source'),aspect:'experience'},{ref:pin('note'),aspect:'belief'}]});
  return next(s);
}
export const currentFrame=s=>s.store.read(attentionId('fixture-person'));
export function lookup(s,query,extra={}){
  const decision=commit(s,{kind:'lookup',payload:query},extra);return s.reader.execute({decision:pin(decision.id,decision.revision)});
}
