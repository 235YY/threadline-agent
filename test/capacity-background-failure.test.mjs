// Phase 3.2 rev3 - TE-owned background-capacity failure tests (autonomy/reflection/task/agent + Q1).
// Contract (Lead/E/B rev3): background entries must NOT pay a model call while the host attention
// desk is full; capacity is deferred (recoverable) with markers, due cursor/slot not consumed,
// blocked tasks require released capacity + explicit resume (inbound interrupt cannot auto-wake),
// stats/recovery expose background capacity-deferred effects, ATTENTION_LIMIT is not host capacity.
// Q1: intent model-visible packet exposes the W/remove contract and never used/max.
// Synthetic only: no packaged affect runtime, model/provider/network/QQ. ASCII fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityStore} from '../src/store.mjs';
import {commitDecision} from '../src/cognition.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {attentionId, keepAttention, ATTENTION_CAPACITY_HINT} from '../src/attention.mjs';
import {intentPacket} from '../src/intent-protocol.mjs';
import {mkdtempSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {put, event, frame, ref} from './helpers.mjs';

const T = 1_800_000_000_000;
const clone = value => JSON.parse(JSON.stringify(value));

// Deterministic host-desk filling through the real foreground commit seam.
async function fillDesk(service, {count = 16} = {}) {
  const store = service.store;
  const session = new ContinuitySession({store, subjectId: 'jingyang', attention: true, maxForeground: 16});
  const [firstEvent, workspace] = put(store, 'bgcap-seed', event('bgcap-seed', {scene: 'qq/private/1'}), frame({scene: 'qq/private/1'}));
  const ids = [];
  for (let i = 0; i < count; i++) {
    const packet = await session.prepare({currentEvent: ref(firstEvent), workspace: ref(workspace), now: T + i,
      budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: []});
    const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
      selected: 'w', summary: 'fill desk', used: [],
      continuity: {changes: [{id: 'bgcap-s' + i, expectedRevision: 0, kind: 'feeling', body: 'b', nature: 'self-report'}],
        residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
        attention: {...keepAttention(), residency: {upsert: [{id: 'bgcap-r' + i,
          target: {kind: 'state', ref: {id: 'bgcap-s' + i, revision: 1}}, cue: 'desk ' + i,
          purposes: [{kind: 'self-directed', eventIds: [], questionId: null, appliesTo: null}]}], remove: []}}}});
    await session.commit({packet, output, decisionId: 'bgcap-fill-' + i, requestId: 'bgcap-fill-' + i});
    ids.push('bgcap-r' + i);
  }
  return {session, store, ids};
}
async function releaseDesk({session, store}, ids, n = 1) {
  const seed = [...store.all('event')][0];
  const workspace = [...store.all('workspace')][0];
  const packet = await session.prepare({currentEvent: ref(seed), workspace: ref(workspace), now: T + 500,
    budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: []});
  const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
    selected: 'w', summary: 'release desk', used: [],
    continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
      attention: {...keepAttention(), residency: {upsert: [], remove: ids.slice(0, n)}}}});
  await session.commit({packet, output, decisionId: 'bgcap-release-' + n, requestId: 'bgcap-release-' + n});
}
const frameOf = store => store.read(attentionId('jingyang'));
const capacityDeferredFrom = (store, entry) => [...store.all('extension_record')]
  .filter(r => r.owner === 'jingyang' && r.stateType === 'operation-feedback' && r.value?.stage === 'capacity-deferred' && r.value?.entry === entry);
const waitOutput = packet => JSON.stringify({packetId: packet.packetId,
  options: [{id: 'w', kind: 'wait', payload: {}}], selected: 'w', summary: 'fixture', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, attention: keepAttention()}});
const fullOutput = packet => JSON.stringify({packetId: packet.packetId,
  options: [{id: 'w', kind: 'wait', payload: {}}], selected: 'w', summary: 'fixture', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null,
    observationDisposition: 'handled', attention: keepAttention()}});
const taskFinishOutput = packet => JSON.stringify({packetId: packet.packetId,
  options: [{id: 'f', kind: 'act', payload: {tool: 'task_finish', args: {result: 'synthetic done'}}}], selected: 'f',
  summary: 'task done', used: [], continuity: {changes: [], residency: {add: [], remove: []},
    expressionChoice: null, observationDisposition: 'handled', attention: keepAttention()}});

// ---------------------------------------------------------------------------
test('autonomy: full desk defers before any model call, writes no terminal failure, keeps the slot', async t => {
  let now = T, calls = 0;
  const decide = packet => { calls++; return waitOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true,
    idleIntervalMs: 100, clock: () => now, decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  assert.equal(frameOf(service.store).residences.length, 16, 'host desk is full');

  const deferred = await service.autonomyTick({now});
  assert.equal(deferred.skipped, true);
  assert.equal(deferred.reason, 'capacity-deferred');
  assert.equal(deferred.entry, 'autonomy');
  assert.equal(deferred.capacityDeferred, true);
  assert.equal(deferred.capacity.full, true);
  assert.equal(calls, 0, 'no paid model call while the desk is full');
  assert.equal(capacityDeferredFrom(service.store, 'autonomy').length, 1, 'capacity-deferred marker recorded');
  assert.equal([...service.store.all('extension_record')].filter(r => r.id.includes('autonomy-failure')).length, 0,
    'no terminal autonomy-failure marker');
  const again = await service.autonomyTick({now});
  assert.equal(again.reason, 'capacity-deferred');
  assert.equal(calls, 0, 'repeating the tick cannot pay');
  assert.equal([...service.store.all('decision')].filter(d => String(d.id).startsWith('decision:autonomy:')).length, 0,
    'no autonomy decision/slot consumed');

  await releaseDesk(desk, desk.ids, 1);
  const resumed = await service.autonomyTick({now});
  assert.equal(resumed.ok, true, 'released capacity lets the same cadence run');
  assert.equal(calls, 1, 'exactly one paid call after release');
  assert.equal(service.store.read('decision:autonomy:' + resumed.slot)?.id, 'decision:autonomy:' + resumed.slot);
  const cadence = await service.autonomyTick({now});
  assert.equal(cadence.reason, 'cadence');
  assert.equal(calls, 1, 'no duplicate paid call for the same slot');
});

test('reflection: full desk defers before any model call and does not consume the due cursor', async t => {
  let now = T, calls = 0;
  const decide = packet => { calls++; return waitOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, global: true,
    idleIntervalMs: 100, clock: () => now, decide,
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 0, quietToHour: 0}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  const before = clone(service.context());
  now += 201;
  const deferred = await service.idleReflect();
  assert.equal(deferred.skipped, true);
  assert.equal(deferred.reason, 'capacity-deferred');
  assert.equal(deferred.entry, 'reflection');
  assert.equal(deferred.capacityDeferred, true);
  assert.equal(calls, 0, 'no paid model call while the desk is full');
  assert.equal(capacityDeferredFrom(service.store, 'reflection').length, 1);
  assert.deepEqual(service.context(), before, 'due cursor unchanged while capacity is deferred');

  await releaseDesk(desk, desk.ids, 1);
  let resumed = null;
  for (let attempt = 0; attempt < 3 && calls === 0; attempt++) {
    now += 201;
    resumed = await service.idleReflect();
  }
  assert.equal(resumed?.wake, true, 'released capacity lets the reflection run');
  assert.equal(calls, 1, 'exactly one paid call after release');
  assert.notDeepEqual(service.context(), before, 'successful reflection advances the due cursor');
});

test('task: full desk marks TASK_CAPACITY_DEFERRED preflight, refuses resume, and never pays', async t => {
  let now = T, calls = 0;
  const taskOutput = packet => JSON.stringify({packetId: packet.packetId,
    options: [{id: 'f', kind: 'act', payload: {tool: 'task_finish', args: {result: 'synthetic done'}}}], selected: 'f',
    summary: 'task done', used: [], continuity: {changes: [], residency: {add: [], remove: []},
      expressionChoice: null, observationDisposition: 'handled', attention: keepAttention()}});
  const decide = packet => { calls++; return taskOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, clock: () => now,
    decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  const task = await service.createAgentTask({goal: 'capacity background task', target: 'agent/task', metadata: {allowedTools: []}});

  const deferred = await service.stepAgentTask(task.id);
  assert.equal(deferred.error, 'TASK_CAPACITY_DEFERRED');
  assert.equal(deferred.capacityDeferred, true);
  assert.equal(deferred.entry, 'task');
  assert.equal(calls, 0, 'no paid task step while the desk is full');
  const blocked = service.listAgent().find(x => x.id === task.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(String(blocked.blockedReason), /^TASK_CAPACITY_DEFERRED:preflight:/);
  assert.equal([...service.store.all('decision_attempt')].some(a => a.status === 'rejected' || a.status === 'quarantined'), false);
  assert.equal([...service.store.all('affect_turn')].length, 0);

  await assert.rejects(() => service.resumeAgentTask(task.id), e => e.code === 'CAPACITY_NOT_RELEASED');
  assert.equal(service.listAgent().find(x => x.id === task.id).status, 'blocked', 'resume refused while full');
  assert.equal(calls, 0);

  await releaseDesk(desk, desk.ids, 1);
  const resumed = await service.resumeAgentTask(task.id);
  assert.equal(resumed.ok, true, 'explicit resume allowed after capacity release');
  const stepped = await service.stepAgentTask(task.id);
  assert.equal(stepped.ok ?? true, true);
  assert.equal(calls, 1, 'exactly one paid task step after release');
  assert.equal(service.listAgent().find(x => x.id === task.id).status, 'done');
});

test('task: a blocked capacity-deferred task is not auto-woken by an inbound interrupt', async t => {
  let now = T, calls = 0;
  const decide = packet => { calls++; return waitOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, clock: () => now,
    decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  const task = await service.createAgentTask({goal: 'capacity interrupt task', target: 'agent/task', metadata: {allowedTools: []}});
  await service.stepAgentTask(task.id);
  assert.equal(calls, 0);
  assert.match(String(service.listAgent().find(x => x.id === task.id).blockedReason), /^TASK_CAPACITY_DEFERRED:/);

  now += 10;
  service.observe({source: 'synthetic', key: 'bgcap-int-1', text: 'task:' + task.id + ' a new task message', scene: 'agent/task', actor: 'p', at: now});
  assert.equal(service.listAgent().find(x => x.id === task.id).status, 'blocked',
    'inbound interrupt must not auto-wake a capacity-deferred task');
  assert.equal(calls, 0);
  assert.equal(service.listAgent().find(x => x.id === task.id).interrupts.length, 1,
    'the interrupt is recorded for the operator');
  const tick = await service.agentTick();
  assert.equal(tick.skipped ?? false, true);
  assert.equal(calls, 0, 'agent tick cannot pay while the task is capacity-deferred');

  await releaseDesk(desk, desk.ids, 1);
  const resumed = await service.resumeAgentTask(task.id);
  assert.equal(resumed.ok, true);
  const ticked = await service.agentTick();
  assert.ok(ticked);
  assert.equal(calls, 1, 'exactly one paid step after release + explicit resume');
});

test('agent tool_receipt entry: full desk defers the background turn with zero calls', async t => {
  let now = T, calls = 0;
  const decide = packet => { calls++; return fullOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, clock: () => now,
    decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  const store = service.store;
  const receipt = store.execute({requestId: 'bgcap-agent-receipt', commands: [
    {op: 'append_event', id: 'bgcap-agent-receipt', body: 'tool result', scene: 'agent/task', actor: 'agent',
      origin: 'tool_receipt', source: {system: 'agent-runtime', key: 'bgcap-agent-receipt'}, occurredAt: now},
    {op: 'admit_subject_event', subjectId: 'jingyang', event: {id: 'bgcap-agent-receipt', revision: 1}}
  ]}).at(-1);
  assert.ok(receipt);
  const deferred = await service.turn();
  assert.equal(deferred.ok, false);
  assert.equal(deferred.reason, 'capacity-deferred');
  assert.equal(deferred.entry, 'agent');
  assert.equal(calls, 0, 'no model call for a tool_receipt while full');
  assert.equal(capacityDeferredFrom(store, 'agent').length, 1);

  await releaseDesk(desk, desk.ids, 1);
  // A fresh tool_receipt proves the agent entry runs again once capacity is released.
  store.execute({requestId: 'bgcap-agent-receipt-2', commands: [
    {op: 'append_event', id: 'bgcap-agent-receipt-2', body: 'tool result 2', scene: 'agent/task', actor: 'agent',
      origin: 'tool_receipt', source: {system: 'agent-runtime', key: 'bgcap-agent-receipt-2'}, occurredAt: now},
    {op: 'admit_subject_event', subjectId: 'jingyang', event: {id: 'bgcap-agent-receipt-2', revision: 1}}
  ]});
  await service.turn();
  assert.equal(calls, 1, 'exactly one paid background turn after release');
});

test('stats/recovery expose background capacity-deferred effects and release readiness', async t => {
  let now = T, calls = 0;
  const decide = packet => { calls++; return waitOutput(packet); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true,
    global: true, idleIntervalMs: 100, clock: () => now, decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const desk = await fillDesk(service);
  await service.autonomyTick({now});
  now += 201;
  await service.idleReflect();
  now += 10;
  const task = await service.createAgentTask({goal: 'stats task', target: 'agent/task', metadata: {allowedTools: []}});
  await service.stepAgentTask(task.id);
  assert.equal(calls, 0);

  const before = service.stats().metrics.inbox.capacityDeferred;
  assert.ok(before.count >= 3, 'background capacity-deferred effects are visible');
  const entries = new Set(before.items.map(x => x.entry));
  for (const entry of ['autonomy', 'reflection', 'task']) assert.ok(entries.has(entry), entry + ' visible');
  for (const item of before.items) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.reason, 'string');
    assert.equal(item.releaseReady, false, 'full desk is not release-ready');
  }
  assert.equal([...service.store.all('decision_attempt')].some(a => a.status === 'rejected' || a.status === 'quarantined'), false,
    'capacity deferral is never a journal rejected/quarantine');
  assert.equal([...service.store.all('affect_turn')].length, 0);

  await releaseDesk(desk, desk.ids, 1);
  const after = service.stats().metrics.inbox.capacityDeferred;
  assert.ok(after.items.length >= 3);
  for (const item of after.items) {
    assert.equal(item.releaseReady, true, 'after release every deferred effect is release-ready');
    assert.equal(item.capacity.full, false);
  }
});

test('ATTENTION_LIMIT stays a shape/semantic error, never a background capacity gate', async t => {
  let now = T, calls = 0;
  const decide = () => { calls++; throw Object.assign(new Error('shape limit'), {code: 'ATTENTION_LIMIT', name: 'ContractError'}); };
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true,
    idleIntervalMs: 100, clock: () => now, decide, subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  await assert.rejects(() => service.autonomyTick({now}), e => e.code === 'ATTENTION_LIMIT');
  assert.equal(calls, 1, 'roomy desk reaches the semantic model path');
  assert.equal(capacityDeferredFrom(service.store, 'autonomy').length, 0,
    'ATTENTION_LIMIT must not be reported as host capacity deferral');
});

// ---------------------------------------------------------------------------
test('restart: capacity-deferred autonomy/task never repay after a service restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-bgcap-'));
  const storePath = join(dir, 'core.sqlite');
  const opened = [];
  let now = T, calls = 0;
  const decide = packet => { calls++; return packet?.payload?.task ? taskFinishOutput(packet) : waitOutput(packet); };
  const open = async () => {
    const service = await startBrainService({port: 0, storePath, heartbeatMs: 0, autonomy: true, idleIntervalMs: 100,
      clock: () => now, decide, subjectTask: true, agentTools: {},
      shutdownControl: {token: 'operator-test', stop: async () => {}}});
    opened.push(service);
    return service;
  };
  const close = service => new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { service.close(); } catch {} resolve(); };
    try { if (service.server.listening) service.server.close(finish); else finish(); } catch { finish(); }
    setTimeout(finish, 300);
  });
  t.after(async () => {
    for (const service of opened) if (service.server.listening) await close(service);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(storePath + suffix); } catch {} }
    try { rmdirSync(dir); } catch {}
  });
  const s1 = await open();
  t.after(() => close(s1));
  const desk = await fillDesk(s1);
  assert.equal((await s1.autonomyTick({now})).reason, 'capacity-deferred');
  assert.equal(calls, 0, 'full desk defers autonomy before restart');
  const task = await s1.createAgentTask({goal: 'restart task', target: 'agent/task', metadata: {allowedTools: []}});
  assert.equal((await s1.stepAgentTask(task.id)).error, 'TASK_CAPACITY_DEFERRED');
  assert.equal(calls, 0, 'full desk defers the task preflight before restart');
  await close(s1);

  const s2 = await open();
  t.after(() => close(s2));
  assert.equal(frameOf(s2.store).residences.length, 16, 'full desk persisted across restart');
  assert.equal(s2.listAgent().find(x => x.id === task.id).status, 'blocked');
  assert.equal((await s2.autonomyTick({now})).reason, 'capacity-deferred');
  assert.equal(calls, 0, 'restart cannot repay a deferred autonomy opportunity');
  const releaseSession = new ContinuitySession({store: s2.store, subjectId: 'jingyang', attention: true, maxForeground: 16});
  await releaseDesk({session: releaseSession, store: s2.store}, desk.ids, 1);
  assert.equal((await s2.autonomyTick({now})).ok, true);
  assert.equal(calls, 1, 'autonomy pays exactly once after release');
  assert.equal((await s2.resumeAgentTask(task.id)).ok, true);
  await s2.stepAgentTask(task.id);
  assert.equal(calls, 2, 'task pays exactly once after release');
  await close(s2);

  const s3 = await open();
  t.after(() => close(s3));
  const before = calls;
  await s3.autonomyTick({now});
  await s3.agentTick();
  assert.equal(calls, before, 'restart after success never repays a settled background decision');
});

// ---------------------------------------------------------------------------
// rev4: persistent non-foreground capacity dimensions (graph processes / deferrals).
async function fillGraph(service, n = 128) {
  const store = service.store;
  const session = new ContinuitySession({store, subjectId: 'jingyang', attention: true, maxForeground: 16});
  const [seed, workspace] = put(store, 'gseed', event('gseed', {scene: 'qq/private/1'}), frame({scene: 'qq/private/1'}));
  let serial = 0;
  for (let batch = 0; batch * 16 < n; batch++) {
    const packet = await session.prepare({currentEvent: ref(seed), workspace: ref(workspace), now: T + (++serial),
      budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: []});
    const count = Math.min(16, n - batch * 16);
    const processes = Array.from({length: count}, (_, i) => ({id: 'gproc' + (batch * 16 + i), expectedRevision: 0,
      label: 'g' + (batch * 16 + i), body: 'b', status: 'active', world: 'actual', intervals: [], basis: []}));
    const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
      selected: 'w', summary: 'graph fill', used: [],
      continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
        attention: {...keepAttention(), processes}}});
    await session.commit({packet, output, decisionId: 'gfill' + batch, requestId: 'gfill' + batch});
  }
  return async function releaseGraph() {
    const packet = await session.prepare({currentEvent: ref(seed), workspace: ref(workspace), now: T + 900,
      budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: []});
    const proc = frameOf(store).processes.find(p => !['completed', 'abandoned'].includes(p.status));
    const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
      selected: 'w', summary: 'graph release', used: [],
      continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
        attention: {...keepAttention(), processes: [{id: proc.id, expectedRevision: proc.revision, label: proc.label,
          body: proc.body, status: 'completed', world: proc.world, intervals: [], basis: []}]}}});
    await session.commit({packet, output, decisionId: 'grelease', requestId: 'grelease'});
  };
}
async function fillDeferrals(service, n = 32) {
  const store = service.store;
  const session = new ContinuitySession({store, subjectId: 'jingyang', attention: true, maxForeground: 16});
  const [seed, workspace] = put(store, 'dseed', event('dseed', {scene: 'qq/private/1'}), frame({scene: 'qq/private/1'}));
  let serial = 0;
  for (let batch = 0; batch * 16 < n; batch++) {
    const packet = await session.prepare({currentEvent: ref(seed), workspace: ref(workspace), now: T + (++serial),
      budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: [],
      materials: [{ref: {id: seed.id, revision: 1}, aspect: 'experience'}]});
    const count = Math.min(16, n - batch * 16);
    const upsert = Array.from({length: count}, (_, i) => ({id: 'gdf' + (batch * 16 + i),
      ref: {id: seed.id, revision: 1}, condition: {kind: 'host', expr: 'x'}}));
    const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
      selected: 'w', summary: 'deferral fill', used: [],
      continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
        attention: {...keepAttention(), deferrals: {upsert, restore: [], cancel: []}}}});
    commitDecision({store, packet, output, requestId: 'dfill' + batch, decisionId: 'dfill' + batch});
  }
  return async function releaseDeferrals() {
    const packet = await session.prepare({currentEvent: ref(seed), workspace: ref(workspace), now: T + 900,
      budgetBytes: 131072, mind: true, unified: true, localLookupPolicy: {maxReads: 1, maxHits: 2}, allowedActionTools: [],
      materials: [{ref: {id: seed.id, revision: 1}, aspect: 'experience'}]});
    const ids = (frameOf(store).deferrals ?? []).filter(d => !['restored', 'cancelled'].includes(d.status)).slice(0, 2).map(d => d.id);
    const output = JSON.stringify({packetId: packet.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
      selected: 'w', summary: 'deferral release', used: [],
      continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled',
        attention: {...keepAttention(), deferrals: {upsert: [], restore: [], cancel: ids}}}});
    commitDecision({store, packet, output, requestId: 'drelease', decisionId: 'drelease'});
  };
}
function fourEntryDecide(counter) {
  return packet => {
    counter.calls++;
    if (packet?.payload?.task) return taskFinishOutput(packet);
    if (packet?.stage === 'reflection' || packet?.payload?.internal?.kind === 'autonomy') return waitOutput(packet);
    return fullOutput(packet);
  };
}
function failNextCommit(service, code = 'RESIDENCE_UPSERT_CAPACITY') {
  const store = service.store, original = store.execute;
  let armed = true;
  store.execute = function (input) {
    const commands = input?.commands ?? [];
    if (armed && commands.some(command => command?.op === 'advance_subject')) {
      armed = false;
      throw Object.assign(new Error('synthetic typed commit-limit'), {code, name: 'ContractError'});
    }
    return original.call(this, input);
  };
  return () => { store.execute = original; };
}
async function deliverReceipt(service, id, now) {
  service.store.execute({requestId: id, commands: [
    {op: 'append_event', id, body: 'tool result', scene: 'agent/task', actor: 'agent', origin: 'tool_receipt',
      source: {system: 'agent-runtime', key: id}, occurredAt: now},
    {op: 'admit_subject_event', subjectId: 'jingyang', event: {id, revision: 1}}
  ]});
}
async function assertAllEntriesDeferred(service, counter, nowRef) {
  const deferredAutonomy = await service.autonomyTick({now: nowRef.now});
  assert.equal(deferredAutonomy.reason, 'capacity-deferred', 'autonomy gate');
  assert.equal(deferredAutonomy.capacityDeferred, true);
  assert.equal(counter.calls, 0, 'autonomy pays nothing');
  const cursorBefore = clone(service.context());
  nowRef.now += 201;
  const deferredReflection = await service.idleReflect();
  assert.equal(deferredReflection.reason, 'capacity-deferred', 'reflection gate');
  assert.equal(counter.calls, 0, 'reflection pays nothing');
  assert.deepEqual(service.context(), cursorBefore, 'reflection cursor untouched');
  const task = await service.createAgentTask({goal: 'background capacity task', target: 'agent/task', metadata: {allowedTools: []}});
  const deferredTask = await service.stepAgentTask(task.id);
  assert.equal(deferredTask.error, 'TASK_CAPACITY_DEFERRED', 'task preflight gate');
  assert.equal(counter.calls, 0, 'task pays nothing');
  await assert.rejects(() => service.resumeAgentTask(task.id), e => e.code === 'CAPACITY_NOT_RELEASED');
  await assert.rejects(() => service.redirectAgentTask(task.id, {goal: 'redirect'}), e => e.code === 'CAPACITY_NOT_RELEASED');
  nowRef.now += 10;
  await deliverReceipt(service, 'rev4-agent-receipt-' + nowRef.now, nowRef.now);
  const deferredAgent = await service.turn();
  assert.equal(deferredAgent.reason, 'capacity-deferred', 'agent gate');
  assert.equal(deferredAgent.entry, 'agent');
  assert.equal(counter.calls, 0, 'agent pays nothing');
  const items = service.stats().metrics.inbox.capacityDeferred.items;
  const entries = new Set(items.map(item => item.entry));
  for (const entry of ['autonomy', 'reflection', 'task', 'agent']) assert.ok(entries.has(entry), entry + ' visible in stats');
  for (const item of items) assert.equal(item.releaseReady, false, 'full dimension is not release-ready');
  return task;
}

test('graph full (processes 128/128) defers autonomy/reflection/task/agent with zero model calls', async t => {
  const nowRef = {now: T}, counter = {calls: 0};
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true, global: true,
    idleIntervalMs: 100, clock: () => nowRef.now, decide: fourEntryDecide(counter), subjectTask: true, agentTools: {},
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 0, quietToHour: 0}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const releaseGraph = await fillGraph(service, 128);
  const frame = frameOf(service.store);
  assert.equal(frame.residences.length, 0, 'foreground is not full');
  assert.equal(frame.processes.filter(p => !['completed', 'abandoned'].includes(p.status)).length, 128);
  const task = await assertAllEntriesDeferred(service, counter, nowRef);
  const graphDeferred = await service.autonomyTick({now: nowRef.now});
  assert.equal(graphDeferred.capacity.used.processes, 128, 'gate reports the graph dimension');
  assert.equal(graphDeferred.capacity.full, true);

  await releaseGraph();
  const releasedItems = service.stats().metrics.inbox.capacityDeferred.items;
  for (const item of releasedItems) assert.equal(item.releaseReady, true, 'all deferred effects become release-ready');
  const resumedAutonomy = await service.autonomyTick({now: nowRef.now});
  assert.equal(resumedAutonomy.ok, true, 'autonomy runs after graph release');
  assert.equal(counter.calls, 1, 'autonomy pays exactly once');
  const resumedTask = await service.resumeAgentTask(task.id);
  assert.equal(resumedTask.ok, true, 'task resume allowed after graph release');
  await service.stepAgentTask(task.id);
  assert.equal(counter.calls, 2, 'task pays exactly once after explicit resume');
});

test('deferrals full (32 active) defers autonomy/reflection/task/agent with zero model calls', async t => {
  const nowRef = {now: T}, counter = {calls: 0};
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true, global: true,
    idleIntervalMs: 100, clock: () => nowRef.now, decide: fourEntryDecide(counter), subjectTask: true, agentTools: {},
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 0, quietToHour: 0}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const releaseDeferrals = await fillDeferrals(service, 32);
  const frame = frameOf(service.store);
  assert.equal(frame.residences.length, 0, 'foreground is not full');
  assert.equal((frame.deferrals ?? []).filter(d => !['restored', 'cancelled'].includes(d.status)).length, 32);
  const task = await assertAllEntriesDeferred(service, counter, nowRef);
  const deferralDeferred = await service.autonomyTick({now: nowRef.now});
  assert.equal(deferralDeferred.capacity.used.deferrals, 32, 'gate reports the deferral dimension');

  await releaseDeferrals();
  for (const item of service.stats().metrics.inbox.capacityDeferred.items) {
    assert.equal(item.releaseReady, true, 'deferrals released');
  }
  const resumedAutonomy = await service.autonomyTick({now: nowRef.now});
  assert.equal(resumedAutonomy.ok, true, 'autonomy runs after deferral release');
  assert.equal(counter.calls, 1);
  assert.equal((await service.resumeAgentTask(task.id)).ok, true);
  await service.stepAgentTask(task.id);
  assert.equal(counter.calls, 2, 'task pays exactly once after deferral release');
});

// ---------------------------------------------------------------------------
// rev5 durable commit-limit BLOCKED (A path): one paid RESIDENCE_UPSERT_CAPACITY
// failure blocks later automatic opportunities until an explicit operator clear.
async function clearCommitLimit(service, markerId) {
  const response = await fetch(service.url + '/v1/operator/effect', {method: 'POST',
    headers: {'content-type': 'application/json', 'x-jingyang-control': 'operator-test'},
    body: JSON.stringify({type: 'commit-limit', id: markerId, transition: 'clear',
      evidence: {operator: 'te-test-operator'}})});
  return response.json();
}
const commitLimitMarkerId = item => item.marker ?? item.id;
function commitLimitBlockedItems(service, entry) {
  return service.stats().metrics.commitLimits.items.filter(item => item.entry === entry);
}

test('commit-limit blocked: autonomy/reflection stay BLOCKED across opportunities until operator clear', async t => {
  const nowRef = {now: T}, counter = {calls: 0};
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0, autonomy: true, global: true,
    idleIntervalMs: 100, clock: () => nowRef.now, decide: fourEntryDecide(counter), subjectTask: true, agentTools: {},
    shutdownControl: {token: 'operator-test', stop: async () => {}},
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 0, quietToHour: 0}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });

  let restore = failNextCommit(service);
  let autonomyError = null;
  try { await service.autonomyTick({now: nowRef.now}); } catch (error) { autonomyError = error; }
  restore();
  assert.equal(autonomyError?.code, 'RESIDENCE_UPSERT_CAPACITY');
  assert.equal(counter.calls, 1, 'the paid path happened exactly once');
  const autonomyBlock = commitLimitBlockedItems(service, 'autonomy')[0];
  assert.ok(autonomyBlock, 'durable commit-limit marker recorded');
  assert.equal(autonomyBlock.preflightable, false);
  assert.equal(autonomyBlock.autoRecoverable, false);
  assert.equal(autonomyBlock.blocked, true);
  assert.equal(service.stats().metrics.inbox.capacityDeferred.items.some(item => item.entry === 'autonomy'), false,
    'commit-limit is not mixed into capacityDeferred');
  assert.ok(service.health().recovery.commitLimits.count >= 1, 'health recovery exposes commit limits');

  nowRef.now += 100;
  const nextSlot = await service.autonomyTick({now: nowRef.now});
  assert.equal(nextSlot.skipped, true);
  assert.equal(nextSlot.reason, 'commit-limit-blocked');
  assert.equal(nextSlot.commitLimitBlocked, true);
  assert.equal(nextSlot.autoRecoverable, false);
  assert.equal(counter.calls, 1, 'next slot pays nothing while blocked');
  nowRef.now += 1000;
  assert.equal((await service.autonomyTick({now: nowRef.now})).reason, 'commit-limit-blocked');
  assert.equal(counter.calls, 1, 'no later slot repays before an explicit clear');

  assert.equal((await clearCommitLimit(service, commitLimitMarkerId(autonomyBlock))).ok, true, 'operator clear accepted');
  nowRef.now += 100;
  const resumedAutonomy = await service.autonomyTick({now: nowRef.now});
  assert.equal(resumedAutonomy.ok, true, 'next opportunity runs after explicit clear');
  assert.equal(counter.calls, 2, 'exactly one paid call after clear');

  // Reflection: the same durable blocked semantics on its due window.
  nowRef.now += 201;
  restore = failNextCommit(service);
  let reflectionError = null;
  for (let attempt = 0; attempt < 3 && !reflectionError; attempt++) {
    try { await service.idleReflect(); } catch (error) { reflectionError = error; }
    if (!reflectionError) nowRef.now += 201;
  }
  restore();
  assert.equal(reflectionError?.code, 'RESIDENCE_UPSERT_CAPACITY');
  assert.equal(counter.calls, 3, 'reflection paid exactly once');
  const reflectionBlock = commitLimitBlockedItems(service, 'reflection')[0];
  assert.ok(reflectionBlock, 'reflection marker recorded');
  assert.equal(reflectionBlock.preflightable, false);
  nowRef.now += 201;
  const reflectionBlocked = await service.idleReflect();
  assert.equal(reflectionBlocked.reason, 'commit-limit-blocked');
  assert.equal(counter.calls, 3, 'next due pays nothing');
  nowRef.now += 201;
  assert.equal((await service.idleReflect()).reason, 'commit-limit-blocked');
  assert.equal(counter.calls, 3, 'later due window still blocked');
  assert.equal(service.stats().metrics.inbox.capacityDeferred.items.some(item => item.entry === 'reflection'), false);

  assert.equal((await clearCommitLimit(service, commitLimitMarkerId(reflectionBlock))).ok, true);
  for (let attempt = 0; attempt < 3 && counter.calls === 3; attempt++) {
    nowRef.now += 201;
    await service.idleReflect();
  }
  assert.equal(counter.calls, 4, 'exactly one paid reflection after clear');
});

test('commit-limit blocked: task resume/redirect need explicit evidence; inbound interrupt never wakes', async t => {
  const nowRef = {now: T}, counter = {calls: 0};
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0,
    clock: () => nowRef.now, decide: fourEntryDecide(counter), subjectTask: true, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  const task = await service.createAgentTask({goal: 'commit limit task', target: 'agent/task', metadata: {allowedTools: []}});
  const restore = failNextCommit(service);
  const step = await service.stepAgentTask(task.id);
  restore();
  assert.equal(step.error, 'RESIDENCE_UPSERT_CAPACITY');
  assert.equal(counter.calls, 1, 'one paid task attempt');
  const blocked = service.listAgent().find(item => item.id === task.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockedReason, 'TASK_COMMIT_LIMIT:RESIDENCE_UPSERT_CAPACITY');
  await assert.rejects(() => service.resumeAgentTask(task.id), e => e.code === 'TASK_COMMIT_LIMIT_REVIEW_REQUIRED');
  await assert.rejects(() => service.redirectAgentTask(task.id, {}), e => e.code === 'TASK_COMMIT_LIMIT_REVIEW_REQUIRED');
  assert.equal(counter.calls, 1, 'refusals pay nothing');
  const marker = service.stats().metrics.commitLimits.items.find(item => item.id === task.id || item.entry === 'task');
  assert.ok(marker, 'task commit-limit visible');
  assert.equal(marker.preflightable, false);
  assert.equal(service.stats().metrics.inbox.capacityDeferred.items.some(item => item.id === task.id), false,
    'task commit-limit is not capacityDeferred');

  nowRef.now += 10;
  service.observe({source: 'synthetic', key: 'commit-limit-int', text: 'task:' + task.id + ' inbound message',
    scene: 'agent/task', actor: 'p', at: nowRef.now});
  const afterInterrupt = service.listAgent().find(item => item.id === task.id);
  assert.equal(afterInterrupt.status, 'blocked', 'inbound interrupt never wakes a commit-limit blocked task');
  assert.equal(afterInterrupt.interrupts.length, 1, 'interrupt recorded for the operator');
  await service.agentTick();
  assert.equal(counter.calls, 1, 'agent tick pays nothing while commit-limit blocked');
  const stepAgain = await service.stepAgentTask(task.id);
  assert.equal(stepAgain.ok, false, 'blocked task step cannot pay again');
  assert.ok(['TASK_COMMIT_LIMIT', 'NOT_RUNNABLE', 'AGENT_BUSY'].includes(stepAgain.error), String(stepAgain.error));
  assert.equal(counter.calls, 1, 'no second paid task attempt');

  assert.equal((await service.resumeAgentTask(task.id, {message: 'explicit operator input'})).ok, true,
    'explicit new input clears the marker and resumes');
  await service.stepAgentTask(task.id);
  assert.equal(counter.calls, 2, 'exactly one paid step after explicit resume');
  assert.equal(service.listAgent().find(item => item.id === task.id).status, 'done');
});

test('commit-limit blocked marker survives restart and clears explicitly once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-bgcap-limit-'));
  const storePath = join(dir, 'core.sqlite');
  const opened = [];
  let now = T, calls = 0;
  const decide = packet => { calls++; if (packet?.payload?.task) return taskFinishOutput(packet); return waitOutput(packet); };
  const open = async () => {
    const service = await startBrainService({port: 0, storePath, heartbeatMs: 0, autonomy: true, idleIntervalMs: 100,
      clock: () => now, decide, subjectTask: true, agentTools: {},
      shutdownControl: {token: 'operator-test', stop: async () => {}}});
    opened.push(service);
    return service;
  };
  const close = service => new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { service.close(); } catch {} resolve(); };
    try { if (service.server.listening) service.server.close(finish); else finish(); } catch { finish(); }
    setTimeout(finish, 300);
  });
  t.after(async () => {
    for (const service of opened) if (service.server.listening) await close(service);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(storePath + suffix); } catch {} }
    try { rmdirSync(dir); } catch {}
  });
  const first = await open();
  const restore = failNextCommit(first);
  let error = null;
  try { await first.autonomyTick({now}); } catch (caught) { error = caught; }
  restore();
  assert.equal(error?.code, 'RESIDENCE_UPSERT_CAPACITY');
  assert.equal(calls, 1);
  const marker = first.stats().metrics.commitLimits.items.find(item => item.entry === 'autonomy');
  assert.ok(marker);
  await close(first);

  const second = await open();
  now += 100;
  const blocked = await second.autonomyTick({now});
  assert.equal(blocked.reason, 'commit-limit-blocked', 'blocked marker persists across restart');
  assert.equal(calls, 1, 'restart does not repay');
  assert.equal((await clearCommitLimit(second, commitLimitMarkerId(marker))).ok, true);
  now += 100;
  const resumed = await second.autonomyTick({now});
  assert.equal(resumed.ok, true);
  assert.equal(calls, 2, 'explicit clear resumes exactly once after restart');
});

// ---------------------------------------------------------------------------
// rev6 (F-REV5 P1): agent tool_receipt commit-limit is entry-scoped: any fresh
// receipt stays blocked (0 calls) until an explicit operator clear.
function dropAgentReceipts(service) {
  const store = service.store;
  for (const record of [...store.all('event')]) {
    if (record.origin !== 'tool_receipt' || record.source?.system !== 'agent-runtime') continue;
    const inbox = store.subjectObservation('jingyang', record.id);
    if (inbox?.status !== 'received') continue;
    const subject = store.read('jingyang');
    try {
      store.execute({requestId: 'drop-agent-receipt:' + record.id, commands: [{op: 'fail_subject_event',
        subject: {id: 'jingyang', revision: subject.revision},
        event: {id: record.id, revision: record.revision}, reason: 'TEST_DROP'}]});
    } catch {}
  }
}
async function turnUntilSettled(service, max = 8) {
  let last = null;
  for (let i = 0; i < max; i++) {
    last = await service.turn();
    if (!service.health().pending.length) break;
  }
  return last;
}

test('agent commit-limit: paid once, fresh receipts stay blocked, operator clear pays once', async t => {
  let now = T, calls = 0;
  const service = await startBrainService({port: 0, storePath: ':memory:', heartbeatMs: 0,
    clock: () => now, decide: packet => { calls++; return fullOutput(packet); }, subjectTask: true, agentTools: {},
    shutdownControl: {token: 'operator-test', stop: async () => {}}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  await deliverReceipt(service, 'agent-limit-receipt-1', now);
  const restore = failNextCommit(service);
  const first = await service.turn();
  restore();
  assert.equal(first.commitLimit, true);
  assert.equal(first.entry, 'agent');
  assert.equal(first.error, 'RESIDENCE_UPSERT_CAPACITY');
  assert.equal(calls, 1, 'first receipt paid exactly once');
  const marker = service.stats().metrics.commitLimits.items.find(item => item.entry === 'agent');
  assert.ok(marker, 'agent commit-limit marker recorded');
  assert.equal(marker.preflightable, false);
  assert.equal(marker.autoRecoverable, false);
  assert.equal(marker.blocked, true);
  assert.equal(service.stats().metrics.inbox.capacityDeferred.items.some(item => item.entry === 'agent'), false,
    'agent commit-limit is not capacityDeferred');
  assert.ok(service.health().recovery.commitLimits.count >= 1);

  dropAgentReceipts(service);
  await turnUntilSettled(service);
  assert.equal(calls, 1, 'draining old receipts never pays');

  await deliverReceipt(service, 'agent-limit-receipt-2', now);
  const second = await service.turn();
  assert.equal(second.commitLimitBlocked, true, 'fresh receipt is blocked by the entry-scoped marker');
  assert.equal(second.reason, 'commit-limit-blocked');
  assert.equal(second.entry, 'agent');
  assert.equal(second.preflightable, false);
  assert.equal(second.autoRecoverable, false);
  assert.equal(calls, 1, 'fresh receipt paid nothing');
  dropAgentReceipts(service);
  await turnUntilSettled(service);

  now += 10;
  await deliverReceipt(service, 'agent-limit-receipt-3', now);
  const third = await service.turn();
  assert.equal(third.commitLimitBlocked, true, 'another fresh receipt (new key) is still blocked');
  assert.equal(calls, 1, 'no second paid call across fresh receipts');
  dropAgentReceipts(service);
  await turnUntilSettled(service);

  assert.equal((await clearCommitLimit(service, commitLimitMarkerId(marker))).ok, true, 'operator clear accepted');
  now += 10;
  await deliverReceipt(service, 'agent-limit-receipt-4', now);
  const resumed = await service.turn();
  assert.ok(resumed?.ok === true || resumed?.decision || resumed?.result, 'fresh receipt processed after clear');
  assert.equal(calls, 2, 'exactly one paid decision after operator clear');
  assert.equal(service.stats().metrics.commitLimits.items.some(item => item.entry === 'agent'), false,
    'agent marker cleared from stats');
});

test('agent commit-limit marker survives restart and clears to one paid receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-agent-limit-'));
  const storePath = join(dir, 'core.sqlite');
  const opened = [];
  let now = T, calls = 0;
  const decide = packet => { calls++; return fullOutput(packet); };
  const open = async () => {
    const service = await startBrainService({port: 0, storePath, heartbeatMs: 0, clock: () => now,
      decide, subjectTask: true, agentTools: {},
      shutdownControl: {token: 'operator-test', stop: async () => {}}});
    opened.push(service);
    return service;
  };
  const close = service => new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { service.close(); } catch {} resolve(); };
    try { if (service.server.listening) service.server.close(finish); else finish(); } catch { finish(); }
    setTimeout(finish, 300);
  });
  t.after(async () => {
    for (const service of opened) if (service.server.listening) await close(service);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(storePath + suffix); } catch {} }
    try { rmdirSync(dir); } catch {}
  });
  const first = await open();
  await deliverReceipt(first, 'agent-restart-receipt-1', now);
  const restore = failNextCommit(first);
  const failed = await first.turn();
  restore();
  assert.equal(failed.commitLimit, true);
  assert.equal(calls, 1);
  const marker = first.stats().metrics.commitLimits.items.find(item => item.entry === 'agent');
  assert.ok(marker);
  dropAgentReceipts(first);
  await close(first);

  const second = await open();
  now += 10;
  await deliverReceipt(second, 'agent-restart-receipt-2', now);
  const blocked = await second.turn();
  assert.equal(blocked.commitLimitBlocked, true, 'marker persists across restart');
  assert.equal(calls, 1, 'restart does not repay');
  assert.equal((await clearCommitLimit(second, commitLimitMarkerId(marker))).ok, true);
  now += 10;
  await deliverReceipt(second, 'agent-restart-receipt-3', now);
  const resumed = await second.turn();
  assert.ok(resumed?.ok === true || resumed?.decision || resumed?.result);
  assert.equal(calls, 2, 'exactly one paid receipt after restart + clear');
  await close(second);

  const third = await open();
  now += 10;
  await deliverReceipt(third, 'agent-restart-receipt-4', now);
  const normal = await third.turn();
  assert.ok(normal?.ok === true || normal?.decision || normal?.result, 'cleared state stays usable after another restart');
  assert.equal(calls, 3, 'normal paid receipt after clear (no stale blocking)');
});

// ---------------------------------------------------------------------------
// Q1 (B rev3): intent model-visible W/remove contract on a full desk.
test('Q1: full-desk intent view exposes W remove contract (no used/max) and explicit remove works', async t => {
  const store = new ContinuityStore(':memory:');
  t.after(() => store.close());
  const session = new ContinuitySession({store, subjectId: 'jingyang', attention: true, maxForeground: 2});
  const [firstEvent, workspace] = put(store, 'q1-seed', event('q1-m1', {scene: 'qq/private/1'}), frame({scene: 'qq/private/1'}));
  const base = () => ({currentEvent: ref(firstEvent), workspace: ref(workspace), identity: 'synthetic subject', mind: true,
    unified: true, localLookupPolicy: {maxReads: 2, maxHits: 4}, allowedActionTools: [], budgetBytes: 131072, now: T});
  let seq = 0;
  const answer = (packet, intent) => { const wire = intentPacket(packet); seq++; return session.commit({packet,
    output: JSON.stringify({packetId: wire.packetId, ...intent}), decisionId: 'q1-d' + seq, requestId: 'q1-r' + seq}); };
  await answer(await session.prepare({...base(), intentProtocol: true}),
    {decision: {type: 'reply', text: 'ok'}, states: [{kind: 'feeling', text: 'a little worried'}]});
  const ev2 = put(store, 'q1-e2', event('q1-m2', {scene: 'qq/private/1'})).at(-1);
  await answer(await session.prepare({...base(), currentEvent: ref(ev2), intentProtocol: true}),
    {decision: {type: 'reply', text: 'hm'}, states: [{kind: 'feeling', text: 'another thing'}]});
  assert.equal(frameOf(store).residences.length, 2, 'desk is full');

  const ev3 = put(store, 'q1-e3', event('q1-m3', {scene: 'qq/private/1'})).at(-1);
  const fullPacket = await session.prepare({...base(), currentEvent: ref(ev3), intentProtocol: true});
  const fullWire = intentPacket(fullPacket);
  const fullView = JSON.parse(fullWire.messages[1].content).view;
  const fullInstruction = fullWire.messages[0].content;
  assert.equal(fullInstruction.includes(ATTENTION_CAPACITY_HINT), true, 'capacity hint sentence present when full');
  assert.match(fullInstruction, /remove:\s*\["W1"\]/, 'remove/W contract is model-visible');
  assert.match(fullInstruction, /view\.attention[^。]*W/, 'W handles are named in the contract');
  assert.equal(Object.hasOwn(fullView.attention, 'used'), false);
  assert.equal(Object.hasOwn(fullView.attention, 'max'), false);
  assert.equal(JSON.stringify(fullView).includes('"used"'), false);
  assert.equal(JSON.stringify(fullView).includes('"max"'), false);
  const handles = fullView.attention.residences.map(r => r.handle);
  assert.deepEqual(handles, ['W1', 'W2']);
  const stateBefore = store.read(frameOf(store).residences[0].target.ref.id);
  await answer(fullPacket, {decision: {type: 'wait'}, remove: ['W1']});
  assert.equal(frameOf(store).residences.length, 1, 'explicit W remove releases the residence');
  assert.deepEqual(store.read(stateBefore.id), stateBefore, 'remove never edits the state body/version');
  const ev4 = put(store, 'q1-e4', event('q1-m4', {scene: 'qq/private/1'})).at(-1);
  const invalidPacket = await session.prepare({...base(), currentEvent: ref(ev4), intentProtocol: true});
  await assert.rejects(async () => answer(invalidPacket, {decision: {type: 'wait'}, remove: ['W2']}), e => e.code === 'INTENT_HANDLE');
  assert.equal(frameOf(store).residences.length, 1);
});
