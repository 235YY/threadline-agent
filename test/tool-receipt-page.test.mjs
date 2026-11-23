import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDecision,verifiedModelInput} from '../src/cognition.mjs';
import {canonical,digest} from '../src/contracts.mjs';
import {stickerPage} from '../tools/qq-connect/tools.mjs';
import {memory,event,frame,put,ref} from './helpers.mjs';

const list=()=>Array.from({length:200},(_,i)=>({id:String(i),url:'https://example.test/'+i,desc:'条目'+i+'内容'.repeat(65),tags:[i===150?'奶龙':'其他']}));

test('large array receipt is a bounded explicit page; original source and fixed version remain intact',t=>{
  const {store}=memory(t),original=JSON.stringify(list());
  const [current,w]=put(store,'setup',event('receipt',{origin:'tool_receipt',body:original}),frame());
  const p=prepareDecision({store,currentEvent:ref(current),workspace:ref(w),budgetBytes:65000});
  assert.ok(p.bytes<=65000);assert.equal(store.read(current.id).body,original);
  assert.equal(p.payload.current.representation,'bounded-tool-receipt-array-page');
  const d=p.payload.current.bodyDelivery;assert.equal(d.fullBodyDelivered,false);assert.equal(d.total,200);assert.deepEqual(d.source,ref(current));assert.equal(d.sourceBodyFingerprint,digest(original));
  assert.ok(d.count>0&&d.count<=32);assert.equal(d.nextOffset,d.count);
  assert.deepEqual(JSON.parse(p.payload.current.body),list().slice(0,d.count));
  assert.equal(verifiedModelInput(p).bytes,p.bytes);
});

test('paging does not abbreviate actual user messages or small/non-array receipts',t=>{
  const {store}=memory(t);const [current,w]=put(store,'setup',event('user',{body:JSON.stringify(list())}),frame());
  assert.throws(()=>prepareDecision({store,currentEvent:ref(current),workspace:ref(w),budgetBytes:65000}),{code:'INPUT_OVERFLOW'});
  const [receipt]=put(store,'other',event('small',{origin:'tool_receipt',body:'{"status":"succeeded"}'}));
  const p=prepareDecision({store,currentEvent:ref(receipt),workspace:ref(w),budgetBytes:65000});assert.equal(p.payload.current.body,receipt.body);assert.equal(p.payload.current.bodyDelivery,undefined);
});

test('historically sealed unpaged input remains verifiable without rewriting captured material',t=>{
  const {store}=memory(t),body=JSON.stringify(list());const [current,w]=put(store,'setup',event('historical-receipt',{origin:'tool_receipt',body}),frame());
  const p=prepareDecision({store,currentEvent:ref(current),workspace:ref(w),budgetBytes:131072});
  const legacy=structuredClone(p);legacy.payload.current=current;
  legacy.packetId=digest({stage:legacy.stage,instruction:legacy.instruction,payload:legacy.payload});
  legacy.messages=[{role:'system',content:legacy.instruction},{role:'user',content:canonical({packetId:legacy.packetId,...legacy.payload})}];legacy.bytes=Buffer.byteLength(canonical(legacy.messages));
  const serialized=canonical(legacy);assert.equal(verifiedModelInput(legacy).bytes,legacy.bytes);assert.equal(canonical(legacy),serialized);
});

test('sticker read is paginated and searchable; no missing or duplicated items across pages',()=>{
  const rows=list(),seen=[];let offset=0;
  do{const p=stickerPage(rows,{limit:200,offset});assert.ok(p.items.length<=32);assert.ok(Buffer.byteLength(JSON.stringify(p))<14000);seen.push(...p.items.map(x=>x.id));offset=p.nextOffset;}while(offset!==null);
  assert.deepEqual(seen,rows.map(x=>x.id));const p=stickerPage(rows,{query:'奶龙'});assert.equal(p.total,1);assert.equal(p.items[0].id,'150');assert.equal(p.nextOffset,null);
});

test('invalid paging and oversized single items fail explicitly without returning an empty success',()=>{
  for(const args of [{limit:0},{limit:NaN},{offset:-1},{offset:0.5}])assert.throws(()=>stickerPage(list(),args),/STICKER_PAGE_ARGS/);
  assert.throws(()=>stickerPage([{url:'https://example.test',desc:'大'.repeat(5000)}]),/STICKER_ITEM_TOO_LARGE/);
});
