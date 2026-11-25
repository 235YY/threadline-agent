import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {commitDecision} from '../src/cognition.mjs';
import {LocalLookupSession} from '../src/local-lookup.mjs';
import {keepAttention} from '../src/attention.mjs';
import {memory,event,note,frame,put,ref} from './helpers.mjs';

const t0=Date.UTC(2026,10,7,10,0,0);
const attention=()=>({...keepAttention()});

function setup(t){
  const holder=memory(t),store=holder.store;holder.setTime(t0);
  new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
  const w=store.read('qq')??put(store,'workspace',frame({id:'qq',scene:'qq/group/9'}))[0];
  const current=put(store,'cur',event('cur',{body:'刚刚说到照片',origin:'reported',scene:'qq/group/9',occurredAt:t0}))[0];
  const add=(id,body,{scene,actor,at,people=null})=>{
    const scope={scenes:scene?[scene]:[],people:people??[],validFrom:null,validUntil:null};
    if(people)return put(store,id,note(id,[],{body,status:'current',scope}));
    return put(store,id,event(id,{body,origin:'observed',scene,actor,occurredAt:at??t0}));
  };
  add('e1','小红发了照片',{scene:'qq/group/9',actor:'小红',at:t0});
  add('e2','小红私下说照片',{scene:'qq/private/1',actor:'小红',at:t0+100000});
  add('e3','阿蓝发了照片',{scene:'qq/group/9',actor:'阿蓝',at:t0});
  add('n1','照片里是海边',{scene:'qq/group/9',people:['小红']});
  add('n2','照片是旅行',{scene:'qq/private/1',people:['小红']});
  put(store,'n3',note('n3',[],{body:'照片',status:'current',scope:{scenes:[],people:[],validFrom:null,validUntil:null}}));
  return {store,w,current};
}
function prepare(s){
  const session=new ContinuitySession({store:s.store,subjectId:'actor',attention:true,maxForeground:16});
  return session.prepare({currentEvent:ref(s.current),workspace:ref(s.w),identity:'你是小栈。',materials:[],mind:true,unified:true,
    workbenchMaterials:true,workbenchFocus:true,budgetBytes:90000,localLookupPolicy:{maxReads:4,maxHits:8},now:t0});
}
function output(packet,query){
  return JSON.stringify({packetId:packet.packetId,options:[{id:'q',kind:'lookup',payload:query}],selected:'q',summary:'组合回忆',
    used:[],continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
}
function lookup(s,query,id){
  const packet=prepare(s);
  const decision=commitDecision({store:s.store,packet,output:output(packet,query),requestId:id,decisionId:id,allowedActionTools:[]});
  return new LocalLookupSession({store:s.store,subjectId:'actor',policy:{maxReads:4,maxHits:8}}).execute({decision:ref(decision)});
}

test('组合回忆：人+地点+时间+词取交集，不是并集',t=>{
  const s=setup(t);
  const result=lookup(s,{recall:{person:'小红',place:'qq/group/9',time:{from:t0-1000,until:t0+50000},terms:['照片']}},'recall:1');
  assert.equal(result.method,'recall-intersection');
  assert.deepEqual(result.entries.map(e=>e.ref.id).sort(),['e1','n1']);
  assert.equal(result.total,2);
});

test('地点是路径前缀：qq 包含子流；时间区间显式；空结果不猜',t=>{
  const s=setup(t);
  const broad=lookup(s,{recall:{person:'小红',place:'qq',time:{from:t0-1000,until:t0+50000}}},"recall:2");
  assert.deepEqual(broad.entries.map(e=>e.ref.id).sort(),['e1','n1','n2']);
  const none=lookup(s,{recall:{person:'不存在'}},'recall:3');
  assert.equal(none.outcome,'empty');assert.equal(none.total,0);
});

test('recall 边界：至少一个坐标、时间有序、key 白名单、地点层数',t=>{
  const s=setup(t);let n=0;
  const rejects=(query,code)=>assert.throws(()=>lookup(s,query,`bad:${++n}`),{code});
  rejects({recall:{}},'OUTPUT_SHAPE');
  rejects({recall:{time:{from:2,until:1}}},'OUTPUT_LIMIT');
  rejects({recall:{mood:'开心'}},'OUTPUT_SHAPE');
  rejects({recall:{place:'a/b/c/d/e'}},'STREAM_SHAPE');
});
