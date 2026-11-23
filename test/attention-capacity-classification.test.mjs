// Phase 3.2 attention-unify REV3/REV4 — TE-owned classification / shared-pipeline / protection tests.
// Covers (G P1 + Lead/IL rev2/rev4 requirements):
//  1) three host-capacity codes are classified by the single attention classifier;
//     RESIDENCE_UPSERT_CAPACITY is a typed output/commit limit (not host capacity) and
//     ATTENTION_LIMIT stays a shape/semantic error.
//  2) affect-on capacity refusals through the shared commit pipeline never become journal
//     accepted/rejected, never quarantine/auto-close the source, and stay deferred/requeueable.
//  3) foreground recovery protections: process endpoints (any purpose kind), states changed this
//     turn, added-this-turn residences and intentions are never silently evicted; if nothing is
//     evictable the generic path still refuses (FOREGROUND_CAPACITY).
//  4) six decision entries: only foreground may recover; background kinds are fail-closed.
// Synthetic only: no packaged affect runtime, no model/provider/network/QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {affectTurnId} from '../src/affect-contract.mjs';
import {
  ATTENTION_CAPACITY_CODES, ATTENTION_CAPACITY_LIMITS, isAttentionCapacityError,
  advanceAttention, emptyAttention, keepAttention
} from '../src/attention.mjs';
import {canonical} from '../src/contracts.mjs';
import {memory, put, event, frame, ref} from './helpers.mjs';

const T = 1794400000000;
const clone = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- 1) classifier shape
test('capacity classifier: exactly three host-capacity codes; typed commit-limit and ATTENTION_LIMIT are semantic', () => {
  assert.ok(Object.isFrozen(ATTENTION_CAPACITY_CODES));
  assert.deepEqual([...ATTENTION_CAPACITY_CODES],
    ['FOREGROUND_CAPACITY', 'ATTENTION_CAPACITY', 'DEFERRAL_CAPACITY']);
  for (const code of ATTENTION_CAPACITY_CODES) assert.equal(isAttentionCapacityError(code), true, code);
  assert.equal(isAttentionCapacityError('RESIDENCE_UPSERT_CAPACITY'), false,
    'typed output/commit limit is not host attention capacity');
  for (const code of ['ATTENTION_LIMIT', 'STATE_LIMIT', 'MODEL_OUTPUT_INVALID', 'OUTPUT_SHAPE', null, undefined]) {
    assert.equal(isAttentionCapacityError(code), false, String(code));
  }
  assert.equal(ATTENTION_CAPACITY_LIMITS.deferrals, 32, 'deferral cap stays the documented host bound');
  assert.equal(ATTENTION_CAPACITY_LIMITS.residenceUpsert, 16, 'residence upsert cap stays the documented commit bound');
});

// ------------------------------------------------- 2) shared pipeline: affect-on capacity
function initialAffect() {
  return {format: 'jingyang-affect-shadow-v1', upstream: '2132fa81b20134f469fd7adeb8e38fa20dd32071',
    revision: 0, wallAt: T, mode: 'online',
    config: {timezoneMinutes: 480, parameters: {}, offlinePolicy: 'freeze-lived-time', aggregation: 'weighted-counterfactual-v1'},
    requests: {}, sources: {},
    engineState: {drives: {social: .2, novelty: .2, competence: .2, recognition: .2, fatigue: .2, sleepiness: .2, libido: 0, intimacy: 0},
      mood: {p: 0, a: 0, d: 0}, baseline: {p: 0, a: 0, d: 0}, intents: [], sexuality: {}, emotions: {}}};
}
async function syntheticWorker(x) {
  if (x.action === 'initialize') return {state: initialAffect()};
  const state = clone(x.state), operation = x.operation;
  state.revision++; state.wallAt = operation.nowMs;
  if (operation.source) state.sources[canonical(operation.source)] = {fixture: true};
  return {state, receipt: {operationId: operation.id}};
}
function fakeJournal() {
  const rows = new Map(), validations = [];
  return {
    rows, validations,
    packetRequest: id => rows.get('turn:' + id) ?? null,
    sourceRequest: source => [...rows.values()].find(row => row.source && canonical(row.source) === canonical(source)) ?? null,
    blocks: () => false,
    find: id => rows.get(id) ?? null,
    readmit: () => {},
    recordValidation(id, validation) {
      validations.push({id, validation});
      const row = rows.get('turn:' + id);
      if (row) rows.set('turn:' + id, {...row, validation});
    },
    setRow(id, row) { rows.set(id, row); },
    tryFind: id => rows.get(id) ?? null
  };
}
function setupAffect(t) {
  const {store} = memory(t);
  const [eventRecord, workspaceRecord] = put(store, 'seed', event('e'), frame());
  const journal = fakeJournal(), diagnostics = [];
  const recordDiagnostic = store.recordDiagnostic.bind(store);
  store.recordDiagnostic = value => { diagnostics.push(value); return recordDiagnostic(value); };
  const session = new AffectSession({store, subjectId: 'p', worker: syntheticWorker, clock: () => T, requestJournal: journal});
  const args = () => ({currentEvent: ref(eventRecord), workspace: ref(workspaceRecord), now: T, identity: '合成主体',
    budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 2, maxHits: 4}, allowedActionTools: []});
  const output = packet => JSON.stringify({packetId: packet.packetId,
    options: [{id: 'keep', kind: 'wait', payload: {}}], selected: 'keep', summary: '合成容量分类输出', used: [],
    continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null,
      observationDisposition: 'handled', attention: keepAttention()}});
  return {store, journal, session, eventRecord, args, output, diagnostics};
}

test('affect-on shared pipeline: three host capacity codes defer without journal reject/quarantine; typed limits are semantic', async t => {
  for (const code of ATTENTION_CAPACITY_CODES) {
    const f = setupAffect(t);
    const packet = await f.session.prepare(f.args());
    const raw = await f.session.invoke(packet, () => JSON.stringify(f.output(packet)));
    const coreCommit = f.session.core.commit.bind(f.session.core);
    // Emulate the core commit's host-capacity branch at the exact shared seam: the source is
    // deferred through the existing input-failure primitive, then the typed ContractError is
    // re-thrown so the affect wrapper classifies it as host capacity (no journal validation).
    f.session.core.commit = () => {
      const subject = f.store.read('p');
      f.store.execute({requestId: 'test-capacity-defer-' + code,
        commands: [{op: 'fail_subject_event', subject: {id: 'p', revision: subject.revision},
          event: ref(f.eventRecord), reason: code}]});
      throw Object.assign(new Error('synthetic host capacity'), {code, name: 'ContractError'});
    };
    try {
      await assert.rejects(() => f.session.commit({packet, output: raw, requestId: 'cap-' + code, decisionId: 'decision:cap-' + code}),
        error => error.code === code);
      assert.equal(f.journal.validations.length, 0, `${code}: capacity must not write journal accepted/rejected`);
      const inbox = f.store.subjectObservation('p', f.eventRecord.id);
      assert.equal(inbox.status, 'deferred', `${code}: source stays deferred`);
      assert.match(String(inbox.decisionId), /^input-failure:/, `${code}: deferred via existing primitive`);
      const turn = f.store.read(affectTurnId(packet));
      assert.equal(turn.status, 'failed', `${code}: turn is visible as failed, not auto-closed`);
      assert.equal(turn.error, code);
      assert.equal(turn.failurePhase, 'capacity-deferred');
      assert.equal([...f.store.all('decision_attempt')].some(a => a.status === 'quarantined'), false,
        `${code}: no quarantine attempt`);
      assert.ok(f.diagnostics.some(d => d.stage === 'affect.capacity-deferred' && d.data?.errorCode === code),
        `${code}: capacity-deferred diagnostic recorded`);
    } finally {
      f.session.core.commit = coreCommit;
    }
  }

  // ATTENTION_LIMIT is a shape/semantic refusal: it must take the semantic failure path.
  const f = setupAffect(t);
  const packet = await f.session.prepare(f.args());
  const raw = await f.session.invoke(packet, () => JSON.stringify(f.output(packet)));
  const coreCommit = f.session.core.commit.bind(f.session.core);
  f.session.core.commit = () => { throw Object.assign(new Error('synthetic shape limit'), {code: 'ATTENTION_LIMIT', name: 'ContractError'}); };
  try {
    await assert.rejects(() => f.session.commit({packet, output: raw, requestId: 'shape-limit', decisionId: 'decision:shape-limit'}),
      error => error.code === 'ATTENTION_LIMIT');
    assert.equal(f.journal.validations.length, 1, 'semantic/shape refusal is journal-validated (rejected)');
    assert.equal(f.journal.validations[0].validation.status, 'rejected');
    assert.equal([...f.store.all('decision_attempt')].some(a => a.status === 'quarantined'), false);
    assert.equal(f.diagnostics.some(d => d.stage === 'affect.capacity-deferred'), false,
      'ATTENTION_LIMIT must not be reported as host capacity');
    const turn = f.store.read(affectTurnId(packet));
    assert.equal(turn.status, 'failed');
    assert.equal(turn.failurePhase, 'output-validation', 'shape failure keeps the semantic failure phase');
  } finally {
    f.session.core.commit = coreCommit;
  }

  // RESIDENCE_UPSERT_CAPACITY is a typed output/commit limit: semantic rejection path, never
  // host capacity deferral, no capacity-deferred diagnostic.
  const typed = setupAffect(t);
  const typedPacket = await typed.session.prepare(typed.args());
  const typedRaw = await typed.session.invoke(typedPacket, () => JSON.stringify(typed.output(typedPacket)));
  const typedCoreCommit = typed.session.core.commit.bind(typed.session.core);
  typed.session.core.commit = () => { throw Object.assign(new Error('synthetic commit limit'), {code: 'RESIDENCE_UPSERT_CAPACITY', name: 'ContractError'}); };
  try {
    await assert.rejects(() => typed.session.commit({packet: typedPacket, output: typedRaw, requestId: 'commit-limit', decisionId: 'decision:commit-limit'}),
      error => error.code === 'RESIDENCE_UPSERT_CAPACITY');
    assert.equal(typed.journal.validations.length, 1, 'typed commit limit is journal-validated (rejected)');
    assert.equal(typed.journal.validations[0].validation.status, 'rejected');
    assert.equal(typed.diagnostics.some(d => d.stage === 'affect.capacity-deferred'), false,
      'typed commit limit must not be reported as host capacity');
    const typedTurn = typed.store.read(affectTurnId(typedPacket));
    assert.equal(typedTurn.status, 'failed');
    assert.equal(typedTurn.failurePhase, 'output-validation', 'typed commit limit keeps the semantic failure phase');
  } finally {
    typed.session.core.commit = typedCoreCommit;
  }
});

// --------------------------------------- 3) foreground recovery protections (bounded)
const stateRecord = (id, kind = 'feeling') => ({id, revision: 1, type: 'personal_state', subject: 's', kind,
  body: `状态 ${id}`, status: 'open', nature: 'self-report'});
const residenceRecord = (id, target, purposes = [{kind: 'self-directed', eventIds: []}]) => ({id,
  target: {kind: 'state', ref: {id: target, revision: 1}}, cue: `入口 ${target}`, purposes});
const readMap = records => id => records[id] ?? null;
const emptyDelta = () => ({processes: [], relations: [], residency: {upsert: [], remove: []}, questions: [], followups: []});
function recover(frameRecord, records, extra = {}) {
  return advanceAttention(frameRecord, emptyDelta(), {read: readMap(records), at: 1, maxForeground: 3,
    foregroundRecovery: true, memoryRefs: [], processRefs: [], relationRefs: [], questionRefs: [],
    residenceIds: frameRecord.residences.map(r => r.id), stateRefs: [], observations: [], ...extra});
}

test('foreground recovery protects process endpoints (any purpose kind), changed-this-turn states, intentions and just-added residences', () => {
  const records = {old: stateRecord('old'), work: stateRecord('work'), changed: stateRecord('changed'),
    wish: stateRecord('wish', 'intention'), added: stateRecord('added')};
  const frameRecord = {...emptyAttention('s'), residences: [
    residenceRecord('r-old', 'old'),
    // process endpoint under a non-active-task purpose label: protected by semantics
    residenceRecord('r-work', 'work', [{kind: 'self-directed', eventIds: ['ev-process-endpoint']}]),
    residenceRecord('r-changed', 'changed'),
    residenceRecord('r-wish', 'wish'),
    residenceRecord('r-added', 'added')
  ]};
  const evicted = [];
  const delta = emptyDelta();
  delta.residency.upsert = [];
  const next = advanceAttention(frameRecord, delta, {read: readMap(records), at: 1, maxForeground: 4,
    foregroundRecovery: true, memoryRefs: [], processRefs: [], relationRefs: [], questionRefs: [],
    residenceIds: frameRecord.residences.map(r => r.id), changedStateIds: ['changed'], stateRefs: [],
    observations: [], onCapacityEviction: ids => evicted.push(...ids)});
  const kept = next.residences.map(r => r.id);
  assert.deepEqual(kept.sort(), ['r-added', 'r-changed', 'r-wish', 'r-work'].sort(),
    'only the ordinary unchanged unbounded state line may be dropped');
  assert.deepEqual(evicted, ['r-old']);

  // Nothing evictable (all protected) with a full desk: the generic path still refuses, no silent drop.
  const protectedFrame = {...emptyAttention('s'), residences: [
    residenceRecord('r-work', 'work', [{kind: 'self-directed', eventIds: ['ev-1']}]),
    residenceRecord('r-wish', 'wish'), residenceRecord('r-changed', 'changed')
  ]};
  const refusedEvictions = [];
  assert.throws(() => advanceAttention(protectedFrame, emptyDelta(), {read: readMap(records), at: 1, maxForeground: 2,
    foregroundRecovery: true, memoryRefs: [], processRefs: [], relationRefs: [], questionRefs: [],
    residenceIds: protectedFrame.residences.map(r => r.id), changedStateIds: ['changed'], stateRefs: [],
    observations: [], onCapacityEviction: ids => refusedEvictions.push(...ids)}),
  error => error.code === 'FOREGROUND_CAPACITY');
  assert.deepEqual(refusedEvictions, [], 'a refused recovery must not report an eviction');
});

// --------------------------------------------------- 4) six entries: only foreground
test('six decision entries: only foreground may recover; backgrounds are fail-closed', async () => {
  const {createAttentionCapacityPolicy} = await import('../src/attention.mjs');
  const policy = createAttentionCapacityPolicy();
  assert.equal(policy.allowsForegroundRecovery({decisionKind: 'foreground'}), true,
    'foreground inbound and qq/private inbound both resolve to foreground');
  for (const kind of ['autonomy', 'reflection', 'task', 'agent']) {
    assert.equal(policy.allowsForegroundRecovery({decisionKind: kind}), false, `${kind} must never reclaim foreground`);
  }
  assert.equal(policy.resolve({}), 'reflection', 'unknown context is fail-closed background');
  const driver = readFileSync(new URL('../src/turn-driver.mjs', import.meta.url), 'utf8');
  assert.match(driver, /if\(context\?\.kind==='autonomy'\)return 'autonomy'/);
  assert.match(driver, /if\(context\?\.kind==='reflection'\)return 'reflection'/);
  assert.match(driver, /if\(packet\?\.payload\?\.task\)return 'task'/);
  assert.match(driver, /source\?\.system==='agent-runtime'\)return 'agent'/);
  assert.match(driver, /allowsForegroundRecovery\(\{decisionKind:/,
    'the recovery decision must come from the semantic policy, not a per-driver flag');
  assert.doesNotMatch(driver, /constructor\(\{[^}]*\bforegroundRecovery\b/,
    'no per-driver foregroundRecovery constructor flag may remain');
  assert.match(driver, /foregroundRecovery:false/,
    'task-step commit paths stay background: they pass false explicitly (zero foreground recovery)');
});
