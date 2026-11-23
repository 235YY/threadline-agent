import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as sqlite from 'node:sqlite';
import {ContinuityStore} from '../src/store.mjs';
import {code, disk, event, frame, memory, note, put, ref} from './helpers.mjs';

test('compact transaction replay reads the original revision and accepts legacy inline rows',t=>{
 const path=disk(t),cmd=note('same-note',[],{body:'large body '.repeat(300)});
 let store=new ContinuityStore(path,{clock:()=>2000});
 try{
  const v1=put(store,'v1',cmd);
  put(store,'v2',{...cmd,expectedRevision:1,body:'new body'});
  store.close();
  const db=new sqlite.DatabaseSync(path);
  try{
   const replay=db.prepare("SELECT result FROM operations WHERE request_id='v1'").get();
   assert.ok(replay.result.length<200,'result stores a fixed reference rather than a second body');
   db.prepare("UPDATE operations SET result=? WHERE request_id='v2'").run(JSON.stringify([{legacy:true}]));
  }finally{db.close();}
  store=new ContinuityStore(path);
  assert.deepEqual(put(store,'v1',cmd),v1);
  assert.deepEqual(put(store,'v2',{...cmd,expectedRevision:1,body:'new body'}),[{legacy:true}]);
  assert.throws(()=>put(store,'v1',{...cmd,body:'other'}),{code:'REQUEST_COLLISION'});
 }finally{store.close();}
});

test('committed events and all note revisions survive reopening', t => {
  const path = disk(t); let store = new ContinuityStore(path, {clock: () => 2000});
  const [e] = put(store, 'event', event('e'));
  put(store, 'first', note('n', [ref(e)]));
  put(store, 'change', note('n', [ref(e)], {expectedRevision: 1, body: '新的理解', change: 'reinterpretation'}));
  store.close(); store = new ContinuityStore(path);
  try {
    assert.equal(store.read('n', 1).body, '认识 n');
    assert.equal(store.read('n').body, '新的理解');
    assert.deepEqual(store.integrity(), {database: 'ok', foreignKeyViolations: 0, missingHeads: 0});
  } finally { store.close(); }
});

test('a failed multi-command operation leaves neither partial writes nor its idempotency key', t => {
  const {store} = memory(t);
  assert.throws(() => put(store, 'batch', event('e'), note('n', [{id: 'missing', revision: 1}])), code('MISSING_REFERENCE'));
  assert.equal(store.read('e'), null);
  assert.equal(store.snapshot().operations.length, 0);
  assert.equal(put(store, 'batch', event('e'))[0].id, 'e');
});

test('idempotency is durable and ignores subsequent clock changes', t => {
  const {store, setTime} = memory(t);
  const first = put(store, 'same', event('e'));
  setTime(9999);
  assert.deepEqual(put(store, 'same', event('e')), first);
  assert.throws(() => put(store, 'same', event('another')), code('REQUEST_COLLISION'));
  assert.equal(store.read('another'), null);
});

test('source deduplication and immutable events prevent duplicated or rewritten experience', t => {
  const {store} = memory(t); put(store, 'one', event('e'));
  assert.throws(() => put(store, 'rewrite', event('e', {body: '改写过去'})), code('IMMUTABLE_EVENT'));
  assert.throws(() => put(store, 'clone', event('clone', {source: {system: 'fixture', key: 'e'}})), code('DUPLICATE_SOURCE'));
  assert.equal(store.read('e').body, '事件 e');
  assert.equal(store.read('clone'), null);
});

test('two connections cannot overwrite each other with a stale note revision', t => {
  const path = disk(t), a = new ContinuityStore(path), b = new ContinuityStore(path);
  try {
    put(a, 'create', note('n'));
    const stale = b.read('n');
    put(a, 'advance', note('n', [], {expectedRevision: 1, body: '先到的新观点'}));
    assert.throws(() => put(b, 'late', note('n', [], {expectedRevision: stale.revision, body: '迟到覆盖'})), code('VERSION_CONFLICT'));
    assert.equal(b.read('n').body, '先到的新观点');
  } finally { b.close(); a.close(); }
});

test('source roots propagate without multiplying derivative summaries', t => {
  const {store} = memory(t); const [e] = put(store, 'e', event('e'));
  const [a] = put(store, 'a', note('a', [ref(e)]));
  const [b] = put(store, 'b', note('b', [ref(e), ref(a.record)]));
  assert.deepEqual(store.roots(ref(b.record)), ['e']);
  assert.throws(() => put(store, 'fake-new', note('b', [ref(a.record)], {expectedRevision: 1})), code('NO_NEW_SOURCE'));
  put(store, 'rethink', note('b', [ref(a.record)], {expectedRevision: 1, change: 'reinterpretation', body: '仍用原依据，换个理解'}));
  assert.deepEqual(store.roots({id: 'b', revision: 2}), ['e']);
});

test('pinned evidence keeps its old meaning and flags transitive descendants after revision', t => {
  const {store} = memory(t); const [e] = put(store, 'e', event('e'));
  const [a] = put(store, 'a', note('a', [ref(e)], {body: '旧理解'}));
  const [b] = put(store, 'b', note('b', [ref(a.record)]));
  const [c] = put(store, 'c', note('c', [ref(b.record)]));
  assert.equal(store.basisChanged(ref(c.record)), false);
  put(store, 'a2', note('a', [ref(e)], {expectedRevision: 1, body: '新理解', change: 'reinterpretation'}));
  assert.equal(store.read('b').evidence[0].revision, 1);
  assert.equal(store.read('a', 1).body, '旧理解');
  assert.equal(store.basisChanged(ref(c.record)), true);
});

test('conflicting views may coexist, suspend and be restored without deleting history', t => {
  const {store} = memory(t);
  const [a,b] = put(store, 'opinions', note('a', [], {kind: 'value', body: '玩笑能让人轻松'}), note('b', [], {kind: 'value', body: '严肃的事情应讲清楚'}));
  put(store, 'conflict', {op: 'write_link', id: 'clash', expectedRevision: 0, from: ref(a.record), to: ref(b.record), relation: 'contradicts', strength: 0.8, direction: 'both'});
  put(store, 'pause', note('a', [], {expectedRevision: 1, status: 'suspended', body: a.record.body}));
  put(store, 'restore', note('a', [], {expectedRevision: 2, body: a.record.body}));
  assert.equal(store.read('a', 2).status, 'suspended');
  assert.equal(store.read('a').status, 'current');
  assert.equal(store.read('b').status, 'current');
  assert.equal(store.activeAssociationEdges().length, 0);
});

test('focus replacement preserves chosen continuity and retains cross-environment lookup', t => {
  const {store} = memory(t);
  const [book] = put(store, 'book', event('book', {body: '刚读完故事', scene: 'reading'}));
  const [feeling] = put(store, 'feeling', note('feeling', [ref(book)], {kind: 'feeling', body: '今天有点累，先慢一点'}));
  put(store, 'first', frame({workingRefs: [ref(book)], continuityRefs: [ref(feeling.record)]}));
  put(store, 'switch', frame({expectedRevision: 1, focus: {id: 'life', label: '朋友问起生活'}, continuityRefs: [ref(feeling.record)]}));
  assert.deepEqual(store.read('qq').workingRefs, []);
  assert.deepEqual(store.read('qq').continuityRefs, [ref(feeling.record)]);
  assert.equal(store.read('book').scene, 'reading');
});

test('reading and searching do not reinforce; actual uses deduplicate by encounter', t => {
  const {store, setTime} = memory(t);
  const [old, current] = put(store, 'events', event('old'), event('current'));
  store.read('old'); store.search({terms: ['old']});
  assert.deepEqual(store.uses('old'), []);
  const usage = {op: 'record_use', memory: ref(old), encounter: ref(current), reason: 'recalled'};
  assert.equal(put(store, 'use', usage)[0].changed, true);
  setTime(3000);
  assert.equal(put(store, 'reuse', {...usage, reason: 'applied'})[0].changed, false);
  assert.equal(store.uses('old').length, 1);
  assert.equal(store.read('old').origin, 'reported');
});

test('imaginary encounters cannot manufacture reinforcement', t => {
  const {store} = memory(t);
  const [old, imagined] = put(store, 'events', event('old'), event('imagined', {origin: 'imagination'}));
  assert.throws(() => put(store, 'use', {op: 'record_use', memory: ref(old), encounter: ref(imagined), reason: 'recalled'}), code('NOT_AN_ENCOUNTER'));
  assert.equal(store.uses('old').length, 0);
});

test('action proposals do not imply completion; actual receipts are atomic and versioned', t => {
  const {store} = memory(t); const [w] = put(store, 'workspace', frame());
  const [action] = put(store, 'propose', {op: 'propose_action', id: 'act', workspace: ref(w), tool: 'mc.inspect', args: {target: 'cart'}});
  assert.equal(action.status, 'proposed'); assert.equal(action.receipt, null);
  const receipt = {op: 'record_receipt', actionId: 'act', expectedRevision: 1, status: 'failed', eventId: 'result', body: '矿车被遮挡，尚未上车', actor: 'mc-adapter', source: {system: 'mc-fixture', key: 'receipt-1'}};
  assert.throws(() => put(store, 'bad-receipt', {...receipt, body: ''}), code('INVALID_INPUT'));
  assert.equal(store.read('result'), null); assert.equal(store.read('act').status, 'proposed');
  const [done] = put(store, 'receipt', receipt);
  assert.equal(done.status, 'failed'); assert.equal(store.read('result').origin, 'tool_receipt');
  assert.equal(store.read('act', 1).status, 'proposed');
  assert.throws(() => put(store, 'again', {...receipt, expectedRevision: 2}), code('ACTION_FINALIZED'));
});

test('a late action cannot attach to a superseded workspace', t => {
  const {store} = memory(t); const [old] = put(store, 'first', frame());
  put(store, 'switch', frame({expectedRevision: 1, focus: {id: 'new', label: '新任务'}}));
  assert.throws(() => put(store, 'late', {op: 'propose_action', id: 'act', workspace: ref(old), tool: 'mc.walk'}), code('STALE_WORKSPACE'));
});

test('exact search reads all pages and preserves source labels, not just newest records', t => {
  const {store} = memory(t);
  for (let batch = 0; batch < 5; batch++) {
    const commands = Array.from({length: 120}, (_, i) => event(`e${String(batch * 120 + i).padStart(4,'0')}`));
    put(store, `batch-${batch}`, ...commands);
  }
  const result = store.search({terms: ['e0599']});
  assert.equal(result.items[0].ref.id, 'e0599');
  assert.equal(result.method, 'exact-substring');
  assert.equal([...store.all('event')].length, 600);
});

test('unrelated SQLite databases are rejected before schema or journal modifications', t => {
  const path = disk(t), Database = sqlite.Database ?? sqlite.DatabaseSync;
  const db = new Database(path); db.exec('CREATE TABLE private_data(body TEXT); PRAGMA user_version=1;'); db.close();
  assert.throws(() => new ContinuityStore(path), code('FOREIGN_DATABASE'));
  const check = new Database(path);
  try { assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['private_data']); }
  finally { check.close(); }
});

test('a committed operation survives abrupt process termination without close()', t => {
  const path = disk(t);
  const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
  const script = `import {ContinuityStore} from ${JSON.stringify(moduleUrl)};
    const store=new ContinuityStore(${JSON.stringify(path)});
    store.execute(${JSON.stringify({requestId:'crash-write', commands:[event('survivor')]})});
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {timeout: 10000, encoding: 'utf8'});
  assert.notEqual(child.status, 0, child.stderr);
  const store = new ContinuityStore(path);
  try {
    assert.equal(store.read('survivor')?.body, '事件 survivor');
    assert.equal(store.integrity().database, 'ok');
    assert.equal(put(store, 'crash-write', event('survivor'))[0].revision, 1);
  } finally { store.close(); }
});

test('retiring or revising an association never silently attaches old links to new notes', t => {
  const {store} = memory(t);
  const [a,b] = put(store,'notes',note('a'),note('b'));
  const link={op:'write_link',id:'ab',expectedRevision:0,from:ref(a.record),to:ref(b.record),relation:'related',strength:0.7,direction:'both'};
  put(store,'link',link); assert.equal(store.activeAssociationEdges().length,1);
  put(store,'retire',{...link,expectedRevision:1,status:'retired'});
  assert.equal(store.activeAssociationEdges().length,0); assert.equal(store.read('ab',1).status,'active');
  put(store,'reactivate',{...link,expectedRevision:2});
  put(store,'new-view',note('a',[],{expectedRevision:1,body:'另一个版本'}));
  assert.equal(store.activeAssociationEdges().length,0);
  assert.equal(store.read('ab').from.revision,1);
});

test('malformed commands and references fail structurally with a clean rollback', t => {
  const {store}=memory(t);
  assert.throws(()=>put(store,'null',null),code('INVALID_INPUT'));
  assert.throws(()=>put(store,'bad-ref',event('e'),note('n',[null])),code('INVALID_INPUT'));
  assert.equal(store.read('e'),null);
  assert.deepEqual(store.integrity(),{database:'ok',foreignKeyViolations:0,missingHeads:0});
});

test('nested read snapshots compose safely and cannot mutate data',t=>{
  const {store}=memory(t);put(store,'seed',event('e'));
  store.view(()=>{
    assert.equal(store.search({terms:['e']}).total,1);
    assert.equal(store.activeAssociationEdges().length,0);
    assert.throws(()=>put(store,'illegal',event('no')),code('WRITE_IN_READ_VIEW'));
  });
  assert.equal(store.read('no'),null);
  assert.equal(put(store,'legal',event('yes'))[0].id,'yes');
});
