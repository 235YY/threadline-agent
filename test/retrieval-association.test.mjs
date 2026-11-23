import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {commitDecision} from '../src/cognition.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,event,note,frame,put,ref} from './helpers.mjs';
import {canonical} from '../src/contracts.mjs';

const t0=Date.UTC(2026,10,7,10,0,0);
const attention=()=>({...keepAttention()});
function setup(t){
  const holder=memory(t),store=holder.store;holder.setTime(t0);
  new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
  const w=store.read('qq')??put(store,'workspace',frame({id:'qq',scene:'qq/group/9'}))[0];
  const current=put(store,'cur',event('cur',{body:'刚刚说到海边照片',origin:'reported',scene:'qq/group/9',occurredAt:t0}))[0];
  put(store,'t1',note('t1',[],{body:'海边照片里小红怕水',status:'current',scope:{scenes:['qq/group/9'],people:['小红'],validFrom:null,validUntil:null}}));
  put(store,'c1',note('c1',[],{body:'小红一直怕水',status:'current',scope:{scenes:['qq/group/9'],people:['小红'],validFrom:null,validUntil:null}}));
  put(store,'c2',note('c2',[],{body:'私下说过她怕水',status:'current',scope:{scenes:['qq/private/1'],people:['小红'],validFrom:null,validUntil:null}}));
  put(store,'d1',note('d1',[],{body:'再远一点的记忆',status:'current',scope:{scenes:['qq/group/9'],people:[],validFrom:null,validUntil:null}}));
  put(store,'link:1',{op:'write_link',id:'link:1',expectedRevision:0,from:ref(store.read('t1')),to:ref(store.read('c1')),relation:'related',direction:'both',strength:0.8,status:'active',basis:[]});
  put(store,'link:2',{op:'write_link',id:'link:2',expectedRevision:0,from:ref(store.read('t1')),to:ref(store.read('c2')),relation:'similar',direction:'both',strength:0.5,status:'active',basis:[]});
  put(store,'link:3',{op:'write_link',id:'link:3',expectedRevision:0,from:ref(store.read('c1')),to:ref(store.read('d1')),relation:'related',direction:'both',strength:0.4,status:'active',basis:[]});
  return {store,w,current};
}
function prepare(s,lookupResults=[]){
  const session=new ContinuitySession({store:s.store,subjectId:'actor',attention:true,maxForeground:16});
  return session.prepare({currentEvent:ref(s.current),workspace:ref(s.w),identity:'你是小栈。',materials:[],mind:true,unified:true,
    workbenchMaterials:true,workbenchFocus:true,budgetBytes:90000,localLookupPolicy:{maxReads:4,maxHits:8},lookupResults});
}
function firstLookup(s){
  const packet=prepare(s);
  const out=JSON.stringify({packetId:packet.packetId,options:[{id:'q',kind:'lookup',payload:{terms:['海边']}}],selected:'q',summary:'查海边',
    used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
  const d=commitDecision({store:s.store,packet,output:out,requestId:'r:1',decisionId:'r:1',allowedActionTools:[]});
  return new LocalLookupSession({store:s.store,subjectId:'actor',policy:{maxReads:4,maxHits:8}}).execute({decision:ref(d)});
}

test('读到结果后才联想：只一跳、带 trigger、跨流只给指针、无正文',t=>{
  const s=setup(t),result=firstLookup(s);
  const packet=prepare(s,[ref(result)]);
  const assoc=packet.payload.information.associations;
  assert.equal(assoc.format,'retrieval-associations-v1');
  const cands=assoc.candidates;
  assert.ok(cands.length>0&&cands.length<=4);
  const c1=cands.find(c=>c.ref.id==='c1');
  assert.ok(c1,'直接相连的旧笔记被勾起');
  assert.equal(c1.via,'retrieval-graph');
  assert.equal(c1.trigger.ref.id,'t1');
  const c2=cands.find(c=>c.ref.id==='c2');
  assert.ok(c2,'跨流也想起，但只是影子');
  assert.equal(c2.scope,'other');assert.match(c2.label,/他处/);
  assert.equal(c2.label.includes('怕水'),false,'跨流不给正文片段');
  assert.equal(cands.some(c=>c.ref.id==='d1'),false,'不扩散：c1 的邻居不再联想');
  assert.equal(cands.every(c=>!Object.hasOwn(c,'body')),true);
  assert.match(assoc.meaning,/not-auto-read/);
});

test('联想不写库、可复现；环图也不会往返',t=>{
  const s=setup(t),result=firstLookup(s);
  const before={events:[...s.store.all('event')].length,notes:[...s.store.all('note')].length,links:[...s.store.all('link')].length};
  const a=prepare(s,[ref(result)]).payload.information.associations;
  const b=prepare(s,[ref(result)]).payload.information.associations;
  assert.deepEqual(canonical(a),canonical(b),'同输入同输出');
  const after={events:[...s.store.all('event')].length,notes:[...s.store.all('note')].length,links:[...s.store.all('link')].length};
  assert.deepEqual(after,before,'联想不写事件/笔记/链接');
  put(s.store,'link:back',{op:'write_link',id:'link:back',expectedRevision:0,from:ref(s.store.read('c1')),to:ref(s.store.read('t1')),relation:'related',direction:'both',strength:0.3,status:'active',basis:[]});
  const cyc=prepare(s,[ref(result)]).payload.information.associations;
  assert.ok(cyc.candidates.length<=4,'有环也有限');
  assert.equal(cyc.candidates.some(c=>c.ref.id==='t1'),false,'触发自身不再作为候选');
});
