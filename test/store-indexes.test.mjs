import test from 'node:test';
import assert from 'node:assert/strict';
import {socialProjection} from '../src/social-projection.mjs';
import {recentContext} from '../src/recent-context.mjs';
import {taskThreads,threadUnits,eventProcessLinks} from '../src/task-threads.mjs';
import {attentionId} from '../src/attention.mjs';
import {SCENARIOS as NAT} from '../experiments/naturalness/scenarios.mjs';
import {SCENARIOS as STUDY} from '../experiments/intent-study/scenarios.mjs';

const INDEXED=['newestInScene','newestFromSender','eventsInThread','decisionsForEvent','actionForReceipt','extensionRecords','linksForProcess','countAdmittedEvents'];
// The same store with the index methods hidden: every caller falls back to its full scan.
const scanOnly=store=>new Proxy(store,{get:(t,k)=>INDEXED.includes(k)?undefined:(typeof t[k]==='function'?t[k].bind(t):t[k])});

test('indexed lookups return exactly what the full scans return',()=>{
 const cases=[...Object.values(NAT).map(sc=>sc.build()),...Object.values(STUDY).map(sc=>{const s=sc.build();return {s,e:s.e};})];
 assert.ok(cases.length>=10);
 for(const {s,e} of cases){
  const store=s.store,now=s.clock,frame=store.read(attentionId('jingyang'));
  for(const view of [store,scanOnly(store)])assert.ok(view===store||view.newestInScene===undefined);
  const pair=f=>[f(store),f(scanOnly(store))];
  const [a1,b1]=pair(st=>socialProjection({store:st,subjectId:'jingyang',currentEvent:e,attentionFrame:frame,now}));assert.deepEqual(a1,b1,'social '+e.id);
  const [a2,b2]=pair(st=>recentContext({store:st,subjectId:'jingyang',currentEvent:e,scene:e.scene,limit:50}));assert.deepEqual(a2,b2,'recent '+e.id);
  const [a3,b3]=pair(st=>eventProcessLinks({store:st,subjectId:'jingyang'}));assert.deepEqual(a3,b3);
  if(frame){
   const [a4,b4]=pair(st=>taskThreads({store:st,frame,currentEvent:e}));assert.deepEqual(a4,b4,'threads '+e.id);
   for(const p of frame.processes){const [a5,b5]=pair(st=>threadUnits({store:st,subjectId:'jingyang',threadId:p.id}));assert.deepEqual(a5,b5,'units '+p.id);}
  }
  store.close();
 }
});

test('lookups use the new indexes rather than scanning every record',()=>{
 const {s}=NAT['group-secret'].build();
 const T="coalesce(json_extract(v.body,'$.occurredAt'),json_extract(v.body,'$.recordedAt'))";
 const q=w=>s.store.queryPlan(`SELECT v.body FROM versions v CROSS JOIN objects o ON o.id=v.id AND o.current_revision=v.revision WHERE ${w}`).join(' | ');
 assert.match(q(`o.type='event' AND json_extract(v.body,'$.scene')='x' ORDER BY ${T} DESC LIMIT 5`),/versions_by_scene_time/);
 assert.match(q(`o.type='event' AND json_extract(v.body,'$.sender.id')='1' ORDER BY ${T} DESC LIMIT 5`),/versions_by_sender_time/);
 assert.match(q(`o.type='decision' AND json_extract(v.body,'$.currentEvent.id')='e' ORDER BY o.id`),/versions_by_current_event/);
 assert.match(q(`o.type='extension_record' AND json_extract(v.body,'$.stateType')='a' AND json_extract(v.body,'$.owner')='b' ORDER BY o.id`),/versions_by_state_type/);
 s.store.close();
});

test('search prefilter in SQLite returns the same hits as the full scan',async()=>{
 const {ContinuityStore}=await import('../src/store.mjs');const {put,event,note}=await import('./helpers.mjs');
 const store=new ContinuityStore(':memory:');
 const bodies=['港口货单 12 TEU','Kitchen schedule','kitchen 排班','无关的话','PORT manifest','Café 小店','café 大店'];
 bodies.forEach((b,i)=>put(store,'e'+i,event('e'+i,{body:b})));
 put(store,'n',note('n1',[],{body:'港口 结论 Kitchen'}));
 const scan=new Proxy(store,{get:(t,k)=>k==='search'?(o=>t.search({...o,contextAnchor:undefined})):(typeof t[k]==='function'?t[k].bind(t):t[k])});
 for(const terms of [['港口'],['kitchen'],['KITCHEN','排班'],['port'],['café'],['不存在']]){
  const fast=store.search({terms,limit:100});
  // Reference: the original JS-only matching over every record.
  const all=[...store.all('event'),...store.all('note')].filter(r=>r.type==='event'||r.status==='current');
  const want=all.filter(r=>terms.some(t=>r.body.toLocaleLowerCase('zh-CN').includes(t.toLocaleLowerCase('zh-CN')))).map(r=>r.id).sort();
  assert.deepEqual(fast.items.map(i=>i.ref.id).sort(),want,terms.join(','));assert.equal(fast.total,want.length);
 }
 store.close();
});
