import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAttention,advanceAttention} from '../src/attention.mjs';

const obs={id:'e1',revision:1};
test('followup 鍙湪 active/proposed process 涓婂缓绔嬶紝涓斿繀椤绘樉寮?target/due/basis',()=>{
  const base=emptyAttention('p');
  const delta={processes:[{id:'task',expectedRevision:0,label:'鍘昏瘯 Gemini',body:'鍥炴潵鎶ュ憡',status:'active',world:'actual',intervals:[],basis:[obs]}],
    relations:[],residency:{upsert:[],remove:[]},questions:[],
    followups:[{id:'f1',processId:'task',targetScene:'qq/private/10001',dueAt:2000,basis:[obs]}]};
  const next=advanceAttention(base,delta,{at:1000,observations:[obs],maxForeground:16});
  assert.equal(next.followups.length,1);assert.equal(next.followups[0].status,'scheduled');
  assert.throws(()=>advanceAttention(base,{...delta,followups:[{...delta.followups[0],targetScene:'global'}]},{at:1000,observations:[obs],maxForeground:16}),e=>e.code==='FOLLOWUP_TARGET');
  assert.throws(()=>advanceAttention(base,{...delta,followups:[{...delta.followups[0],dueAt:999}]},{at:1000,observations:[obs],maxForeground:16}),e=>e.code==='FOLLOWUP_TIME');
});

