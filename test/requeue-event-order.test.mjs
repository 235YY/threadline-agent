// Phase 3.2 IR-01: /v1/recovery/requeue-event ordering and compensation.
// Requirement E: a capacity-deferred source may be explicitly requeued, but a
// handled/quarantined source must never gain a stale retry authorization, and an
// authorization failure after a successful requeue must be compensated back to a
// blocked state (no half-open false pass, no dispatch). No model, no network,
// no production DB, no QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {RequestJournal} from '../src/request-journal.mjs';

const T = 1794400000000;
const BRAIN = {'x-brain-token': 'brain-token'};
const CONTROL = {'x-jingyang-control': 'op-token'};
const attention = () => ({processes: [], relations: [], residency: {upsert: [], remove: []}, questions: []});
const output = (p, disposition = 'handled') => JSON.stringify({packetId: p.packetId,
  options: [{id: 'r', kind: 'respond', payload: {text: '合成回复'}}], selected: 'r', summary: 'ir-01 fixture', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null,
    observationDisposition: disposition, attention: attention()}});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jy-ir01-'));
  const ledgerPath = join(dir, 'ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({format: 'jingyang-daily-brain-budget-v1', requests: []}));
  const journalPath = join(dir, 'requests.json');
  const state = {calls: 0, disposition: 'handled'};
  const journal = new RequestJournal(journalPath);
  const decide = p => { state.calls++; return output(p, state.disposition); };
  decide.requestJournal = journal;
  const services = [];
  const start = async () => {
    const s = await startBrainService({port: 0, token: 'brain-token', storePath: join(dir, 'subject.sqlite'),
      stateDirectory: join(dir, 'state'), heartbeatMs: 0, global: true, clock: () => T,
      runtimeInfo: {ledgerPath}, shutdownControl: {token: 'op-token', stop: async () => {}}, decide});
    services.push(s);
    return s;
  };
  const post = async (s, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {method: 'POST',
      headers: {'content-type': 'application/json', ...BRAIN, ...headers}, body: JSON.stringify(body)});
    return {status: res.status, body: await res.json()};
  };
  const requeue = (s, eventId, reason = 'IR-01 fixture requeue') =>
    post(s, '/v1/recovery/requeue-event', {eventId, reason}, CONTROL);
  const settleRow = (requestId, event, fingerprint, packetId) => {
    const source = {subject: 'jingyang', kind: 'event', event: {id: event.id, revision: event.revision}};
    journal.reserve(requestId, fingerprint, 10, {source, packetId});
    journal.dispatch(requestId); journal.settle(requestId, {upperMicros: 10});
    journal.attachOutput(requestId, '{"packetId":"' + packetId + '"}');
    return {requestId, source};
  };
  t.after(async () => {
    for (const s of services) { try { await new Promise(r => s.server.close(r)); } catch {} try { s.close(); } catch {} }
    try { journal.close(); } catch {}
    try { rmSync(dir, {recursive: true, force: true}); } catch {}
  });
  return {dir, state, journal, journalPath, start, post, requeue, settleRow};
}

test('IR-01a handled inbox: requeue-event is refused and leaves no stale retry authorization', async t => {
  const f = fixture(t), s = await f.start();
  await s.reply({scene: 'qq/private/1', key: 'private:1', message_id: 'm1', messages: [{role: 'user', content: '合成已处理消息'}]});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/1');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
  const {requestId, source} = f.settleRow('turn:handled-source', event, 'a'.repeat(64), 'b'.repeat(64));
  const rowsBefore = Object.keys(f.journal.data.requests).length, callsBefore = f.state.calls,
    decisionsBefore = [...s.store.all('decision')].length;

  const refused = await f.requeue(s, event.id);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'REQUEUE_STATE');
  const retry = f.journal.inspectRetry(requestId);
  assert.equal(retry.authorized, false, 'no retryAuthorization may be left behind');
  assert.equal(retry.evidenceHash, null);
  assert.equal(f.journal.blocks(source), true, 'the settled source must stay blocked');
  assert.equal(f.journal.find(requestId).status, 'settled');
  assert.equal(Object.keys(f.journal.data.requests).length, rowsBefore);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
  assert.equal(f.state.calls, callsBefore, 'refusal never dispatches a model request');
  assert.equal([...s.store.all('decision')].length, decisionsBefore);
});

test('IR-01b deferred inbox: requeue-event returns the evidence hash and unblocks the source', async t => {
  const f = fixture(t), s = await f.start();
  f.state.disposition = 'deferred';
  await s.reply({scene: 'qq/private/2', key: 'private:2', message_id: 'm2', messages: [{role: 'user', content: '合成延后消息'}]});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/2');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'deferred');
  const {requestId, source} = f.settleRow('turn:deferred-source', event, 'c'.repeat(64), 'd'.repeat(64));

  const requeued = await f.requeue(s, event.id);
  assert.equal(requeued.status, 200);
  assert.equal(requeued.body.requestId, requestId);
  assert.match(requeued.body.evidenceHash, /^[a-f0-9]{64}$/, 'route returns the evidence hash it authorized');
  assert.equal(requeued.body.observation.status, 'received');
  const retry = f.journal.inspectRetry(requestId);
  assert.equal(retry.authorized, true);
  assert.equal(retry.evidenceHash, requeued.body.evidenceHash);
  assert.equal(retry.evidence.requestId, requestId);
  assert.equal(f.journal.blocks(source), false, 'an authorized source must not stay blocked');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');
});

test('IR-01c crash window after requeue, before authorize: rerun authorizes exactly once', async t => {
  const f = fixture(t), s = await f.start();
  f.state.disposition = 'deferred';
  await s.reply({scene: 'qq/private/3', key: 'private:3', message_id: 'm3', messages: [{role: 'user', content: '合成崩溃窗口消息'}]});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/3');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'deferred');
  const {requestId, source} = f.settleRow('turn:crash-window', event, 'e'.repeat(64), 'f'.repeat(64));
  // Simulate "requeue committed, process died before authorizeRetry": the inbox is
  // received but no authorization exists yet.
  s.store.execute({requestId: 'simulated-pre-crash-requeue', commands: [{op: 'requeue_subject_event',
    subjectId: 'jingyang', event: {id: event.id, revision: event.revision}, reason: 'simulated crash window'}]});
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');
  assert.equal(f.journal.inspectRetry(requestId).authorized, false);
  const rowsBefore = Object.keys(f.journal.data.requests).length, callsBefore = f.state.calls;

  const rerun = await f.requeue(s, event.id);
  assert.equal(rerun.status, 200);
  assert.match(rerun.body.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(f.state.calls, callsBefore, 'the operator route itself never dispatches a model request');
  const authorized = f.journal.inspectRetry(requestId);
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.evidenceHash, rerun.body.evidenceHash);
  assert.equal(f.journal.blocks(source), false);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');

  // A second run is idempotent: same evidence hash, same row, no second authorization.
  const again = await f.requeue(s, event.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.evidenceHash, rerun.body.evidenceHash);
  assert.equal(f.journal.inspectRetry(requestId).evidenceHash, rerun.body.evidenceHash);
  assert.equal(Object.keys(f.journal.data.requests).length, rowsBefore, 'rerun reuses the same journal row');
});

test('IR-01d authorize failure after requeue is compensated back to a blocked deferred source', async t => {
  const f = fixture(t), s = await f.start();
  f.state.disposition = 'deferred';
  await s.reply({scene: 'qq/private/4', key: 'private:4', message_id: 'm4', messages: [{role: 'user', content: '合成补偿消息'}]});
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/4');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'deferred');
  const {requestId, source} = f.settleRow('turn:compensate-source', event, 'a'.repeat(64), 'b'.repeat(64));
  const rowsBefore = Object.keys(f.journal.data.requests).length;

  // Simulate a fault inside the authorization step after the requeue committed.
  const realAuthorize = f.journal.authorizeRetry.bind(f.journal);
  let fault = true;
  f.journal.authorizeRetry = (...args) => {
    if (fault) { fault = false; throw Object.assign(new Error('synthetic authorize fault'), {code: 'SYNTHETIC_AUTHORIZE_FAULT'}); }
    return realAuthorize(...args);
  };
  const failed = await f.requeue(s, event.id);
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error, 'SYNTHETIC_AUTHORIZE_FAULT');
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'deferred', 'compensation re-defers the source');
  assert.equal(s.store.subjectObservation('jingyang', event.id).decisionId, 'input-failure:jingyang:' + event.id);
  const afterFault = f.journal.inspectRetry(requestId);
  assert.equal(afterFault.authorized, false, 'no usable authorization is left open');
  assert.equal(f.journal.blocks(source), true, 'the source is blocked again after compensation');
  assert.equal(Object.keys(f.journal.data.requests).length, rowsBefore, 'compensation creates no journal row');
  assert.equal(f.journal.find(requestId).status, 'settled');
  // KNOWN GAP (reported to Lead/E/Integration Lead, not asserted away): re-running
  // the route after compensation returns 200 with an authorization, but the inbox
  // stays 'deferred' because the retry replays the already-committed
  // `operator-requeue:<eventId>:<reason>` store request and does not re-apply the
  // requeue. The authorized source is then undispatchable. Healing needs a distinct
  // requeue request identity (or a compensation-aware preflight).
});
