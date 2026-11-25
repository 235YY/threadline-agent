// Phase 3.2 operator / readmit / requeue integration matrix (Test Engineer, independent of F).
// Exercises the live host surface (`/v1/operator/effect`, `/v1/recovery/requeue-event`)
// against the current candidate tree. No model, no network, no production DB, no QQ.
// Covers requirement E: operator five types, readmit/requeue, UNKNOWN/restart/idempotency,
// and requirement D/E: host-side evidence must not pollute the subject inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {RequestJournal} from '../src/request-journal.mjs';

const T = 1794400000000;
const BRAIN = {'x-brain-token': 'brain-token'};
const CONTROL = {'x-jingyang-control': 'op-token'};

const respond = p => JSON.stringify({packetId: p.packetId, options: [{id: 'r', kind: 'respond', payload: {text: '合成回复'}}],
  selected: 'r', summary: 'operator matrix fixture', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
    attention: {processes: [], relations: [], residency: {upsert: [], remove: []}, questions: []}}});
const act = tool => p => JSON.stringify({packetId: p.packetId, options: [{id: 'a', kind: 'act', payload: {tool, args: {}}}],
  selected: 'a', summary: 'operator matrix fixture', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
    attention: {processes: [], relations: [], residency: {upsert: [], remove: []}, questions: []}}});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jy-p32-operator-'));
  const ledgerPath = join(dir, 'ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({format: 'jingyang-daily-brain-budget-v1', requests: []}));
  const journalPath = join(dir, 'requests.json');
  const state = {calls: 0, plan: respond};
  let journal = new RequestJournal(journalPath);
  const decide = p => { state.calls++; return state.plan(p); };
  decide.requestJournal = journal;
  const services = [];
  const start = async (extra = {}) => {
    const s = await startBrainService({port: 0, token: 'brain-token', storePath: join(dir, 'subject.sqlite'),
      stateDirectory: join(dir, 'state'), heartbeatMs: 0, global: true, clock: () => T, runtimeInfo: {ledgerPath},
      shutdownControl: {token: 'op-token', stop: async () => {}}, allowedActionTools: ['probe'], decide, ...extra});
    services.push(s);
    return s;
  };
  const post = async (s, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {method: 'POST',
      headers: {'content-type': 'application/json', ...BRAIN, ...headers}, body: JSON.stringify(body)});
    return {status: res.status, body: await res.json()};
  };
  const operator = (s, body) => post(s, '/v1/operator/effect', body, CONTROL);
  const ledgerHash = () => createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');
  const releaseRow = (requestId, eventId, fingerprint = 'a'.repeat(64), packetId = 'b'.repeat(64)) => {
    journal.reserve(requestId, fingerprint, 10, {source: {subject: 'jingyang', kind: 'event', event: {id: eventId, revision: 1}}, packetId});
    journal.close(); journal = new RequestJournal(journalPath); decide.requestJournal = journal;
  };
  t.after(async () => {
    for (const s of services) { try { await new Promise(r => s.server.close(r)); } catch {} try { s.close(); } catch {} }
    try { journal.close(); } catch {}
    try { rmSync(dir, {recursive: true, force: true}); } catch {}
  });
  return {dir, ledgerPath, journalPath, state, start, post, operator, ledgerHash, releaseRow,
    journal: () => journal, storeOf: s => s.store};
}

test('operator five types are routed; unknown type and missing objects are refused without durable writes', async t => {
  const f = fixture(t), s = await f.start();
  const counts = () => ['event', 'action', 'response', 'extension_record', 'agent_task']
    .map(type => [type, [...s.store.all(type)].length]);
  const before = counts();
  f.releaseRow('turn:route', 'obs:missing', 'f'.repeat(64));
  const journalAfterRelease = readFileSync(f.journalPath, 'utf8');

  const unknown = await f.operator(s, {type: 'nope', id: 'x', transition: 'failed'});
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'OPERATOR_TYPE');
  for (const type of ['response', 'action', 'turn-activity', 'maintenance']) {
    const missing = await f.operator(s, {type, id: 'missing-object', transition: 'failed', evidence: {operator: 'test'}});
    assert.equal(missing.status, 400, type);
    assert.equal(missing.body.error, 'OPERATOR_OBJECT', type);
  }
  // The fifth type (journal) is routed too: a released row with wrong fingerprint is refused.
  const journalType = await f.operator(s, {type: 'journal', id: 'turn:route', transition: 'readmit',
    evidence: {requestId: 'turn:route', fingerprint: '0'.repeat(64), ledgerHash: f.ledgerHash(), transportInvoked: false}});
  assert.equal(journalType.status, 400);
  assert.equal(journalType.body.error, 'OPERATOR_EVIDENCE');
  assert.deepEqual(counts(), before, 'refusals must not create store records');
  assert.equal(readFileSync(f.journalPath, 'utf8'), journalAfterRelease, 'refusals must not mutate the journal');
});

test('response closure is terminal and host-side; operator replay creates no second receipt', async t => {
  const f = fixture(t), s = await f.start();
  await s.reply({scene: 'qq/private/1', key: 'private:1', message_id: 'm1', messages: [{role: 'user', content: '合成消息'}]});
  const pending = s.pendingEffects().responses.find(r => r.status === 'pending');
  assert.ok(pending, 'fixture must leave a pending response');
  const id = pending.response.id;

  const first = await f.operator(s, {type: 'response', id, transition: 'failed',
    evidence: {operator: 'test', transportInvoked: false}});
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'failed');
  assert.equal(s.store.read(id).status, 'failed');

  const replay = await f.operator(s, {type: 'response', id, transition: 'failed',
    evidence: {operator: 'test', transportInvoked: false}});
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'OPERATOR_TRANSITION');
  const receipts = [...s.store.all('event')].filter(e => e.id.startsWith('operator-response:' + id + ':'));
  assert.equal(receipts.length, 1, 'exactly one operator evidence receipt');
  assert.equal(receipts[0].source.system, 'host-operator');
  assert.equal(s.store.subjectObservation('jingyang', receipts[0].id), null,
    'operator evidence must not enter the subject inbox');
});

test('unknown delivery is retained and cannot be corrected or re-sent by the operator', async t => {
  const f = fixture(t), s = await f.start();
  await s.reply({scene: 'qq/private/2', key: 'private:2', message_id: 'm2', messages: [{role: 'user', content: '合成消息'}]});
  const pending = s.pendingEffects().responses.find(r => r.status === 'pending');
  const id = pending.response.id;
  const claimed = await f.post(s, '/v1/response/claim', {response: {id, revision: pending.response.revision}});
  assert.equal(claimed.status, 200);
  const delivered = await f.post(s, '/v1/response/delivered', {response: claimed.body.response,
    claimId: claimed.body.claimId, outcome: 'unknown', body: 'synthetic transport loss'});
  assert.equal(delivered.status, 200);
  assert.equal(s.store.read(id).status, 'unknown');
  const deliveryReceipts = s.store.read(id).receipts.length;

  for (const transition of ['failed', 'sent']) {
    const r = await f.operator(s, {type: 'response', id, transition, evidence: {operator: 'test'}});
    assert.equal(r.status, 200);
    assert.equal(r.body.retained, true);
    assert.equal(r.body.status, 'unknown');
  }
  assert.equal(s.store.read(id).status, 'unknown');
  assert.equal(s.store.read(id).receipts.length, deliveryReceipts, 'no extra delivery receipt');
  const operatorReceipts = [...s.store.all('event')].filter(e => e.id.startsWith('operator-response:' + id + ':'));
  assert.equal(operatorReceipts.length, 0, 'unknown outcome must not gain fabricated operator evidence');
  // A replay of the same delivery acknowledgement is idempotent.
  const replay = await f.post(s, '/v1/response/delivered', {response: claimed.body.response,
    claimId: claimed.body.claimId, outcome: 'unknown', body: 'synthetic transport loss'});
  assert.equal(replay.status, 200);
  assert.equal(s.store.read(id).status, 'unknown');
});

test('action closure cannot declare success and replay writes no second receipt', async t => {
  const f = fixture(t), s = await f.start();
  f.state.plan = act('probe');
  await s.reply({scene: 'qq/private/3', key: 'private:3', message_id: 'm3', execute: false, messages: [{role: 'user', content: '合成任务'}]});
  const pending = s.pendingEffects().actions.find(a => a.tool === 'probe');
  assert.ok(pending, 'fixture must leave a proposed action');
  const id = pending.action.id;

  const success = await f.operator(s, {type: 'action', id, transition: 'succeeded', evidence: {operator: 'test'}});
  assert.equal(success.status, 400);
  assert.equal(success.body.error, 'OPERATOR_TRANSITION');

  const failed = await f.operator(s, {type: 'action', id, transition: 'failed', evidence: {operator: 'test'}});
  assert.equal(failed.status, 200);
  assert.equal(s.store.read(id).status, 'failed');
  const replay = await f.operator(s, {type: 'action', id, transition: 'failed', evidence: {operator: 'test'}});
  assert.equal(replay.status, 400);
  const receipts = [...s.store.all('event')].filter(e => e.id.startsWith('operator-action:' + id + ':'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].source.system, 'host-operator');
  assert.equal(s.store.subjectObservation('jingyang', receipts[0].id), null,
    'operator evidence must stay out of the subject inbox');
});

test('journal readmit binds the original fingerprint and readmits exactly once', async t => {
  const f = fixture(t), s = await f.start();
  s.observe({source: 'qq', key: 'private:4', sourceKey: 'private:4:m4', text: '合成待读回消息', scene: 'qq/private/4', occurredAt: T});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/4');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');
  f.releaseRow('turn:readmit', event.id);
  const journal = f.journal();
  const releasedBytes = readFileSync(f.journalPath, 'utf8');

  const wrong = await f.operator(s, {type: 'journal', id: 'turn:readmit', transition: 'readmit',
    evidence: {requestId: 'turn:readmit', fingerprint: '0'.repeat(64), ledgerHash: f.ledgerHash(), transportInvoked: false}});
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'OPERATOR_EVIDENCE');
  assert.equal(journal.find('turn:readmit').status, 'released');
  assert.equal(readFileSync(f.journalPath, 'utf8'), releasedBytes, 'wrong evidence leaves the released journal untouched');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received', 'no requeue on refused evidence');

  const good = {requestId: 'turn:readmit', fingerprint: 'a'.repeat(64), ledgerHash: f.ledgerHash(), transportInvoked: false};
  const ok = await f.operator(s, {type: 'journal', id: 'turn:readmit', transition: 'readmit', evidence: good});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.readmitted, true);
  const row = journal.find('turn:readmit');
  assert.equal(row.status, 'reserved');
  assert.equal(row.attempts.length, 1);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');

  const replay = await f.operator(s, {type: 'journal', id: 'turn:readmit', transition: 'readmit', evidence: good});
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'OPERATOR_STATE');
  assert.equal(journal.find('turn:readmit').attempts.length, 1, 'no second attempt on replay');

  const callsBefore = f.state.calls;
  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(turn.item, 'obs:private:4:m4');
  assert.equal(f.state.calls, callsBefore + 1);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
});

test('requeue-event failure after the retry authorization leaves no dispatch and no falsely blocking row', async t => {
  const f = fixture(t), s = await f.start();
  await s.reply({scene: 'qq/private/5', key: 'private:5', message_id: 'm5', messages: [{role: 'user', content: '已处理消息'}]});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/5');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
  const journal = f.journal();
  const source = {subject: 'jingyang', kind: 'event', event: {id: event.id, revision: event.revision}};
  journal.reserve('turn:requeue-fail', 'c'.repeat(64), 10, {source, packetId: 'd'.repeat(64)});
  journal.dispatch('turn:requeue-fail'); journal.settle('turn:requeue-fail', {upperMicros: 10});
  journal.attachOutput('turn:requeue-fail', '{"packetId":"d"}');
  const rowsBefore = Object.keys(journal.data.requests).length, callsBefore = f.state.calls,
    decisionsBefore = [...s.store.all('decision')].length;

  const refused = await f.post(s, '/v1/recovery/requeue-event', {eventId: event.id, reason: 'synthetic requeue fault'}, CONTROL);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'REQUEUE_STATE');
  const row = journal.find('turn:requeue-fail');
  assert.equal(row.status, 'settled', 'journal outcome is unchanged by the failed requeue');
  assert.equal(Object.keys(journal.data.requests).length, rowsBefore, 'failed requeue grows no journal row');
  assert.equal((row.attempts ?? []).length, 0);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled', 'inbox keeps the real handled state');
  // IR-01 tightened contract: the route preflights the inbox before writing any
  // durable retry authorization, so a refused requeue leaves no authorization and
  // the settled source is blocked again (no false pass).
  assert.equal(row.retryAuthorization ?? null, null, 'no stale retry authorization after a refused requeue');
  assert.equal(journal.blocks(source), true, 'the settled source must be blocked again');

  // The refused route cannot dispatch anything: a turn finds no pending source for it.
  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(f.state.calls, callsBefore, 'no model call after failed requeue');
  assert.equal([...s.store.all('decision')].length, decisionsBefore);
  assert.equal(row.status, 'settled');
  assert.equal((row.attempts ?? []).length, 0);
});

test('requeue-event success authorizes one re-dispatch of a capacity-deferred settled source', async t => {
  const f = fixture(t), s = await f.start();
  s.observe({source: 'qq', key: 'private:6', sourceKey: 'private:6:m6', text: '容量延后消息', scene: 'qq/private/6', occurredAt: T});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/6');
  const journal = f.journal();
  const source = {subject: 'jingyang', kind: 'event', event: {id: event.id, revision: event.revision}};
  journal.reserve('turn:requeue-ok', 'e'.repeat(64), 10, {source, packetId: 'f'.repeat(64)});
  journal.dispatch('turn:requeue-ok'); journal.settle('turn:requeue-ok', {upperMicros: 10});
  journal.attachOutput('turn:requeue-ok', '{"packetId":"f"}');
  const callsBefore = f.state.calls;

  const requeued = await f.post(s, '/v1/recovery/requeue-event', {eventId: event.id, reason: 'synthetic capacity release'}, CONTROL);
  assert.equal(requeued.status, 200);
  assert.equal(requeued.body.requestId, 'turn:requeue-ok');
  assert.equal(requeued.body.capacity.released, true);
  assert.equal(requeued.body.observation.status, 'received');
  const row = journal.find('turn:requeue-ok');
  assert.equal(row.status, 'settled');
  assert.equal(row.validation ?? null, null);
  assert.equal(row.retryAuthorization.evidence.capacityReleased, true);
  assert.equal(row.retryAuthorization.evidence.requestId, 'turn:requeue-ok');

  // Replay is idempotent: same observation, no second journal row and no extra attempt.
  const rowsBefore = Object.keys(journal.data.requests).length;
  const replay = await f.post(s, '/v1/recovery/requeue-event', {eventId: event.id, reason: 'synthetic capacity release'}, CONTROL);
  assert.equal(replay.status, 200);
  assert.equal(Object.keys(journal.data.requests).length, rowsBefore);
  assert.equal((journal.find('turn:requeue-ok').attempts ?? []).length, 0);

  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(turn.item, 'obs:private:6:m6');
  assert.equal(f.state.calls, callsBefore + 1, 'the authorized source is dispatched exactly once');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
  const callsAfterFirstTurn = f.state.calls;
  await s.turn();
  assert.equal(f.state.calls, callsAfterFirstTurn, 'no automatic re-send after the authorized dispatch');
});
