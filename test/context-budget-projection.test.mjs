import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedTimeline} from '../src/cognition.mjs';

const ref=(id)=>({id,revision:1});
const bytes=x=>Buffer.byteLength(JSON.stringify(x),'utf8');

function highWater(){
  const recentItems=Array.from({length:50},(_,i)=>({
    at:1700000000000+i,
    ref:ref(`obs:test:${i}`),
    role:i%2?'her':'user',
    scene:'qq/private/1',
    text:'x'.repeat(600),
    message:{format:'jingyang-message-v1',role:'user',content:[{type:'text',text:'y'.repeat(500)}]},
  }));
  const internalSources=Array.from({length:7},(_,i)=>({
    kind:'interpretation-history',
    ref:ref(`internal:test:${i}`),
    value:{summary:'z'.repeat(2600),index:i},
  }));
  return {
    format:'jingyang-decision-continuity-v1',
    current:{type:'event',id:'obs:current',revision:1,origin:'reported',body:'current message'},
    materials:[],
    continuity:{capabilities:{contractVersion:2,enabled:[]},recent:{format:'recent-context-v1',items:recentItems},internalSources},
  };
}

const size=(data,instruction)=>bytes([{role:'system',content:instruction},{role:'user',content:JSON.stringify({packetId:'0'.repeat(64),...data})}]);

test('high-water packet stays in budget and keeps the current event',()=>{
  const data=highWater();const instruction='i'.repeat(12000);
  const out=boundedTimeline(data,instruction,131072);
  assert.ok(size(out,instruction)<=131072-8192);
  assert.equal(out.current.id,'obs:current');
  assert.deepEqual(out.materials,[]);
});

test('compact timeline sheds older interpretation histories before failing',()=>{
  const data=highWater();
  data.continuity.recent.items=data.continuity.recent.items.slice(0,8).map(({text,message,...entry})=>entry);
  for(const source of data.continuity.internalSources)source.value.summary='z'.repeat(4000);
  const instruction='i'.repeat(100000);
  const out=boundedTimeline(data,instruction,131072);
  assert.ok(size(out,instruction)<=131072-8192);
  assert.equal(out.current.id,'obs:current');
  assert.ok(out.continuity.internalSources.length<7);
  assert.ok(out.continuity.budgetDelivery?.omittedInternalSources?.length>0);
});

 test('budget projection includes omission metadata before finalizing and is stable when resealed',()=>{for(const n of [99200,100000,100800,101600]){const data=highWater();data.continuity.recent.items=[];for(const source of data.continuity.internalSources)source.value.summary='z'.repeat(4000);const instruction='i'.repeat(n);const first=boundedTimeline(data,instruction,131072),snapshot=JSON.stringify(first);boundedTimeline(first,instruction,131072);assert.equal(JSON.stringify(first),snapshot,'reseal must not change its own packet at '+n);assert.ok(size(first,instruction)<=131072-8192);}});
