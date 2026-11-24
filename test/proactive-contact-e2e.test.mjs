// Phase 3.2 proactive contact E2E — DRAFT (Test Engineer, TE-owned new file).
// STATUS: drafts the send-gate composition (host ledger seam -> authorizeProactiveContact ->
// claim/send only when authorized) that is runnable on the current tree. The server-level
// Action dispatch / deliveryPin / executeTool mapping is still in the Lead P1-1 + A-domain
// window; those cases are explicit skips below and MUST be finalized (skip removed, file:line
// pinned) before this file is registered in scripts/current-test-files.json.
// No model, no network, no QQ, no production DB: claim/send are local spies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertProactiveHostSend, buildProactiveHostLedger, classifyProactiveHostEntry, proactiveHostTargetClass} from '../src/proactive-contact-host.mjs';
import {authorizeProactiveContact, proactiveAttemptKey, proactiveDayKey, PROACTIVE_DAILY_SOFT_LIMIT, PROACTIVE_RETRY_POLICY} from '../src/proactive-contact.mjs';
import {keepAttention} from '../src/attention.mjs';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {executeTool, sendTargetScene} from '../tools/qq-connect/tools.mjs';

const T = Date.parse('2026-11-20T17:00:00Z'); // Beijing 2026-11-21 01:00
const DAY = proactiveDayKey({now: T});
const ref = (id, revision = 1) => ({id, revision});
const option = (kind, payload) => ({id: 'o', kind, payload});

// ---- persisted Decision/Action fixtures (same shapes the host ledger consumes) ----
function proactiveEntry(index, {targetScene = 'qq/private/7', summary = '想问问她面试结果', reason = null, status = 'proposed'} = {}) {
  const decisionId = 'decision:proactive-e2e:' + index, actionId = 'action:proactive-e2e:' + index;
  const args = {targetScene, text: '在吗'};
  if (reason !== null) args.reason = reason;
  return {decision: {type: 'decision', id: decisionId, revision: 1, recordedAt: T, reflection: false, currentEvent: null,
      input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: null}},
      output: {summary, options: [option('act', {tool: 'proactive_contact', args})], selected: 'o'},
      action: {id: actionId, revision: 1}},
    action: {type: 'action', id: actionId, revision: 1, tool: 'proactive_contact', args,
      inputRefs: [ref('event:e1'), ref('note:n1', 2)], status}};
}
function replyEntry(index) {
  const decisionId = 'decision:reply-e2e:' + index;
  return {decision: {type: 'decision', id: decisionId, revision: 1, recordedAt: T, reflection: false,
      currentEvent: {id: 'event:e1', revision: 1, scene: 'qq/private/7'},
      input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: null}},
      output: {summary: '回复', options: [option('respond', {text: '在的'})], selected: 'o'}},
    response: {type: 'response', id: decisionId + ':response', revision: 1, decision: ref(decisionId), scene: 'qq/private/7'}};
}
function followupEntry(index) {
  const decisionId = 'decision:followup-e2e:' + index;
  return {decision: {type: 'decision', id: decisionId, revision: 1, recordedAt: T, reflection: true, currentEvent: null,
      input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: {id: 'f1', targetScene: 'qq/private/7'}}},
      output: {summary: '跟进', options: [option('respond', {text: '上次说到的事'})], selected: 'o'}},
    response: {type: 'response', id: decisionId + ':response', revision: 1, decision: ref(decisionId), scene: 'qq/private/7'}};
}
function thoughtEntry(index) {
  return {decision: {type: 'decision', id: 'decision:thought-e2e:' + index, revision: 1, recordedAt: T, reflection: true,
    currentEvent: null, input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: null}},
    output: {summary: '想了想', options: [option('wait', {})], selected: 'o'}}};
}
function peekEntry(index) {
  const decisionId = 'decision:peek-e2e:' + index;
  return {decision: {type: 'decision', id: decisionId, revision: 1, recordedAt: T, reflection: true, currentEvent: null,
      input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: null}},
      output: {summary: '看看群', options: [option('act', {tool: 'group_peek', args: {}})], selected: 'o'},
      action: {id: 'action:peek-e2e:' + index, revision: 1}},
    action: {type: 'action', id: 'action:peek-e2e:' + index, revision: 1, tool: 'group_peek', args: {}, inputRefs: [], status: 'proposed'}};
}
function ambiguousEntry() {
  // A respond decision without its persisted response can never be classified: fail closed.
  return {decision: {type: 'decision', id: 'decision:ambiguous-e2e', revision: 1, recordedAt: T, reflection: false,
    currentEvent: {id: 'event:e1', revision: 1, scene: 'qq/private/7'},
    input: {payload: {continuity: {subject: {id: 'jingyang'}}, followup: null}},
    output: {summary: '回复', options: [option('respond', {text: '在的'})], selected: 'o'}}};
}

// Simulated host send path: only an authorized gate result may reach claim/send. Tests assert
// exactly how many claim/send/model steps happened; this mirrors the server seam contract.
function gateAndSend({entries, action, confirmation = undefined, contextRefs = null, dayKey = DAY}) {
  const counts = {claim: 0, send: 0, model: 0};
  try {
    const facts = assertProactiveHostSend({subjectId: 'jingyang', entries, action, dayKey, contextRefs, confirmation: confirmation ?? null});
    const authorized = authorizeProactiveContact({...facts.moduleInput, confirmation: confirmation ?? undefined});
    if (authorized.allowed) {
      counts.claim += 1; // existing claim path would run here
      counts.send += 1;  // existing send path would run here
    }
    return {allowed: authorized.allowed, authorized, facts, counts};
  } catch (error) {
    return {allowed: false, error, counts};
  }
}

test('E2E-A: within the daily soft budget a proactive initiation passes with no reason and zero fabricated confirmation', () => {
  const prior = [proactiveEntry(1), proactiveEntry(2), proactiveEntry(3), proactiveEntry(4)];
  const current = proactiveEntry(5);
  const {allowed, authorized, facts, counts} = gateAndSend({entries: [...prior, current], action: current.action});
  assert.equal(allowed, true);
  assert.equal(authorized.counted, true);
  assert.equal(authorized.attempt.ordinal, 5);
  assert.equal(authorized.budget.used, 4);
  assert.equal(authorized.budget.withinSoftBudget, true);
  assert.equal(authorized.attempt.reason, '想问问她面试结果', 'reason is reconstructed from persisted decision/action, never fabricated');
  assert.equal(authorized.attempt.confirmation, null, 'no confirmation object may be fabricated under the soft budget');
  assert.equal(facts.confirmation, null);
  assert.deepEqual(counts, {claim: 1, send: 1, model: 0}, 'authorized send proceeds exactly once through the gate');
});

test('E2E-B: the sixth initiation without any persisted reason is refused before any claim or model call', () => {
  const prior = Array.from({length: PROACTIVE_DAILY_SOFT_LIMIT}, (_, index) => proactiveEntry(index + 1));
  // No explicit action reason and an empty decision summary: nothing to reconstruct a reason from.
  const sixth = proactiveEntry(9, {summary: ''});
  const {allowed, error, counts} = gateAndSend({entries: [...prior, sixth], action: sixth.action});
  assert.equal(allowed, false);
  assert.equal(error.code, 'PROACTIVE_REASON_REQUIRED');
  assert.deepEqual(counts, {claim: 0, send: 0, model: 0}, 'refusal happens before claim/send/model');
});

test('E2E-C: the sixth initiation with reason + host auto-confirmation passes once and never retries', () => {
  const prior = Array.from({length: PROACTIVE_DAILY_SOFT_LIMIT}, (_, index) => proactiveEntry(index + 1));
  const sixth = proactiveEntry(9, {reason: '答应过明天问她面试结果'});
  const confirmation = {approved: true, evidence: 'host-policy:proactive-soft-budget'};
  const first = gateAndSend({entries: [...prior, sixth], action: sixth.action, confirmation});
  assert.equal(first.allowed, true);
  assert.equal(first.authorized.attempt.ordinal, 6);
  assert.equal(first.authorized.budget.requiresConfirmation, true);
  assert.equal(first.authorized.attempt.confirmation.byHost, true);
  assert.match(first.authorized.attempt.confirmation.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.authorized.retry.automatic, false);
  assert.deepEqual(first.counts, {claim: 1, send: 1, model: 0});

  // After the host claims/sends, the same action is no longer a proposed action: a duplicate
  // attempt can never reach claim/send again (no automatic resend of the same attempt).
  const consumed = {...sixth, action: {...sixth.action, status: 'dispatched'}};
  const again = gateAndSend({entries: [...prior, consumed], action: consumed.action, confirmation});
  assert.equal(again.allowed, false);
  assert.equal(again.error.code, 'PROACTIVE_HOST_STATE');
  assert.deepEqual(again.counts, {claim: 0, send: 0, model: 0});
});

test('E2E-D: group proactive contact is refused before claim/send (group peek stays read-only)', () => {
  assert.equal(proactiveHostTargetClass('qq/group/9'), 'group');
  const group = proactiveEntry(7, {targetScene: 'qq/group/9'});
  const {allowed, error, counts} = gateAndSend({entries: [group], action: group.action});
  assert.equal(allowed, false);
  assert.equal(error.code, 'PROACTIVE_HOST_GROUP_DISABLED');
  assert.deepEqual(counts, {claim: 0, send: 0, model: 0});
  // A group_peek action is uncounted and never a proactive send.
  const ledger = buildProactiveHostLedger({subjectId: 'jingyang', entries: [peekEntry(1)], dayKey: DAY});
  assert.equal(ledger.complete, true);
  assert.equal(ledger.attempts.length, 0);
  assert.equal(ledger.uncounted[0].kind, 'group-peek');
});

test('E2E-E: reply/followup/thought/group-peek do not consume the proactive budget', () => {
  const prior = [replyEntry(1), followupEntry(1), thoughtEntry(1), peekEntry(1)];
  const ledger = buildProactiveHostLedger({subjectId: 'jingyang', entries: prior, dayKey: DAY});
  assert.equal(ledger.complete, true);
  assert.equal(ledger.attempts.length, 0, 'non-initiation decisions are uncounted');
  assert.deepEqual(new Set(ledger.uncounted.map(row => row.kind)), new Set(['reply', 'followup', 'thought', 'group-peek']));
  // With no counted attempts, an initiation still needs no reason or confirmation.
  const current = proactiveEntry(5);
  const facts = assertProactiveHostSend({subjectId: 'jingyang', entries: [...prior, current], action: current.action, dayKey: DAY});
  const authorized = authorizeProactiveContact({...facts.moduleInput});
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.budget.used, 0);
  assert.equal(authorized.attempt.reason, '想问问她面试结果', 'a reason may exist but is never required under the soft budget');
});

test('E2E-F: an incomplete ledger window fails closed with zero claim/send/model calls', () => {
  const current = proactiveEntry(5);
  const {allowed, error, counts} = gateAndSend({entries: [ambiguousEntry(), current], action: current.action});
  assert.equal(allowed, false);
  assert.equal(error.code, 'PROACTIVE_LEDGER_INCOMPLETE');
  assert.ok(error.details?.problems?.some(problem => problem.code === 'PROACTIVE_HOST_AMBIGUOUS'));
  assert.deepEqual(counts, {claim: 0, send: 0, model: 0});
});

test('E2E-G: UNKNOWN delivery never authorizes an automatic resend', () => {
  assert.equal(PROACTIVE_RETRY_POLICY.automatic, false);
  assert.equal(PROACTIVE_RETRY_POLICY.resendOnUnknown, false);
  assert.equal(PROACTIVE_RETRY_POLICY.newDecisionRequired, true);
  // A previously attempted action (now interrupted/unknown) is no longer an authorizable
  // proposed action, so the host gate refuses before any claim/send.
  const interrupted = proactiveEntry(5, {status: 'interrupted'});
  const retry = gateAndSend({entries: [interrupted], action: interrupted.action});
  assert.equal(retry.allowed, false);
  assert.equal(retry.error.code, 'PROACTIVE_HOST_STATE');
  assert.deepEqual(retry.counts, {claim: 0, send: 0, model: 0});
  // Module level: the exact same attempt identity may not be re-authorized in one day.
  const current = proactiveEntry(6);
  const facts = assertProactiveHostSend({subjectId: 'jingyang', entries: [current], action: current.action, dayKey: DAY});
  const first = authorizeProactiveContact({...facts.moduleInput});
  assert.equal(first.allowed, true);
  assert.throws(() => authorizeProactiveContact({...facts.moduleInput,
    attempts: [{attemptKey: first.attempt.key, dayKey: DAY, kind: 'initiation'}]}),
  error => error.code === 'PROACTIVE_DUPLICATE');
});

// ---- P1-1 server host gate (finalized against server.mjs 60A5C744…: host helpers L613-640,
// dispatch external-act branch L682, proactive pre-claim authorization L686-701, actionClaim L839,
// receipt L831; qq tools pin gate tools.mjs L155-171; bootstrap pin map L55-65 / L341). ----
const PROACTIVE_TEST_T = Date.parse('2026-11-20T17:00:00Z'); // Beijing 2026-11-21 01:00 = DAY above
const proactiveOutput = (targetScene, {text = '在吗', reason = null, summary = '主动问问她面试结果'} = {}) => packet => {
  const args = {targetScene, text};
  if (reason !== null) args.reason = reason;
  return JSON.stringify({packetId: packet.packetId,
    options: [{id: 'a', kind: 'act', payload: {tool: 'proactive_contact', args}}], selected: 'a', summary, used: [],
    continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null,
      observationDisposition: 'handled', attention: keepAttention()}});
};
async function proactiveService(t) {
  const state = {calls: 0, plan: null, now: PROACTIVE_TEST_T}, sent = [], steps = [];
  const service = await startBrainService({port: 0, storePath: ':memory:', stateDirectory: null, heartbeatMs: 0,
    global: true, clock: () => state.now, storage: {clock: () => state.now}, allowedActionTools: ['proactive_contact'],
    adapter: {act: async input => {
      sent.push(input);
      const step = steps.shift();
      if (step?.throw) throw step.throw;
      return {message_id: 5000 + sent.length, delivered: true};
    }},
    decide: packet => { state.calls++; return (state.plan ?? proactiveOutput('qq/private/7'))(packet); }});
  t.after(async () => { if (service.server.listening) await new Promise(r => service.server.close(r)); service.close(); });
  return {service, state, sent, steps};
}
const say = (service, messageId) => service.reply({scene: 'qq/private/7', key: '7',
  message_id: String(messageId), messages: [{role: 'user', content: '合成消息'}]});
const actionOfDecision = (service, decisionId) => {
  const decision = service.store.read(decisionId);
  return decision?.action ? service.store.read(decision.action.id) : null;
};

test('E2E-H: server Action sends proactive_contact exactly once through claim/receipt', async t => {
  const f = await proactiveService(t);
  f.state.plan = proactiveOutput('qq/private/7');
  const reply = await say(f.service, 'e2e-h1');
  assert.equal(reply.ok, true);
  assert.equal(f.sent.length, 1, 'authorized private initiation reaches the external send exactly once');
  assert.equal(f.state.calls, 1, 'host authorization/dispatch makes zero extra model calls');
  const action = [...f.service.store.all('action')][0];
  const persisted = f.service.store.read(action.id);
  assert.equal(persisted.status, 'succeeded');
  assert.match(persisted.claimId, /^action-claim:/, 'the send goes through the existing action claim');
  assert.ok(persisted.receipt?.id?.startsWith('host-action:'), 'a durable host receipt records the send');
  assert.equal([...f.service.store.all('event')].filter(event => event.id.startsWith('host-action:')).length, 1);
  const outboxItem = (reply.outbox ?? []).find(item => item.tool === 'proactive_contact');
  assert.deepEqual(outboxItem?.execution, {status: 'succeeded'});
});

test('E2E-I: the sixth same-day initiation with a reason is host-auto-confirmed and sent once', async t => {
  const f = await proactiveService(t);
  f.state.plan = proactiveOutput('qq/private/7');
  for (let index = 1; index <= PROACTIVE_DAILY_SOFT_LIMIT; index++) {
    f.state.now += 30 * 60_000;
    assert.equal((await say(f.service, 'e2e-i' + index)).ok, true);
  }
  assert.equal(f.sent.length, PROACTIVE_DAILY_SOFT_LIMIT);
  const callsBefore = f.state.calls;
  f.state.plan = proactiveOutput('qq/private/7', {reason: '答应过明天问她面试结果', summary: '答应过的事'});
  f.state.now += 30 * 60_000;
  const sixth = await say(f.service, 'e2e-i6');
  assert.equal(sixth.ok, true);
  assert.equal(f.sent.length, PROACTIVE_DAILY_SOFT_LIMIT + 1, 'the sixth initiation is sent exactly once');
  assert.equal(f.state.calls, callsBefore + 1, 'only the decision model call; host auto-confirmation adds no model call');
  const sixthAction = [...f.service.store.all('action')].sort((a, b) => a.recordedAt - b.recordedAt).at(-1);
  const persisted = f.service.store.read(sixthAction.id);
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.args.reason, '答应过明天问她面试结果', 'the subject reason is persisted, not fabricated by the host');
  assert.equal(persisted.args.confirmation, undefined, 'the model never supplies confirmation; host auto-confirm is internal (no operator approval input)');
  assert.equal(Object.hasOwn(persisted.args, 'approved'), false);
  // The no-reason over-budget refusal is the host/module gate asserted in E2E-B above: a valid
  // decision always carries a persisted summary, which is a legal reason source, so the server
  // cannot reach PROACTIVE_REASON_REQUIRED with a well-formed decision (empty summary is rejected
  // earlier as INVALID_INPUT by proposal validation). No fake fixture is manufactured here.
});

test('the ZIP target cooldown refuses a new proactive action before claim',async t=>{
  const f=await proactiveService(t);
  await say(f.service,'cooldown-first');
  f.state.now+=60_000;
  const second=await say(f.service,'cooldown-second');
  const out=second.outbox.find(item=>item.tool==='proactive_contact');
  assert.equal(out?.execution?.error,'POLICY_COOLDOWN');
  const refused=f.service.store.read(out.action.id);
  assert.equal(refused.status,'failed');
  assert.equal(refused.claimId??null,null);
  assert.equal(f.sent.length,1);
});

test('E2E-J: deliveryPin mismatch or missing pin rejects before any transport', async () => {
  assert.equal(sendTargetScene('proactive_contact', {targetScene: 'qq/private/999'}), 'qq/private/999',
    'proactive_contact target scene is the pin scene, not target/id');
  assert.equal(sendTargetScene('proactive_contact', {targetScene: 'qq/group/9'}), 'qq/group/9');
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('network must not be used by a refused send'); };
  try {
    await assert.rejects(executeTool('proactive_contact', {targetScene: 'qq/private/999', text: '合成'}, {pinRequired: true,
      pinTargets: ['qq/private/7'], allowedTools: ['proactive_contact']}),
    error => error.code === 'UNDELIVERED_TARGET' && error.transportInvoked === false);
    await assert.rejects(executeTool('proactive_contact', {targetScene: 'qq/private/7', text: '合成'}, {pinRequired: true,
      allowedTools: ['proactive_contact']}),
    error => error.code === 'DELIVERY_PIN_UNAVAILABLE' && error.transportInvoked === false);
    assert.equal(fetches, 0, 'pin refusal happens before any network/transport');
  } finally { globalThis.fetch = originalFetch; }
});

test('E2E-K: server rejects a qq/group proactive target before claim/send', async t => {
  const f = await proactiveService(t);
  f.state.plan = proactiveOutput('qq/group/123456', {summary: '想主动找群'});
  const reply = await say(f.service, 'e2e-k1');
  assert.equal(reply.ok, true, 'the refused action is recorded, the turn itself does not fail');
  assert.equal(f.sent.length, 0, 'group proactive contact never reaches the external send');
  const action = [...f.service.store.all('action')][0];
  const persisted = f.service.store.read(action.id);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.claimId ?? null, null, 'authorization failed before actionClaim');
  const execution = (reply.outbox ?? []).find(item => item.tool === 'proactive_contact')?.execution;
  assert.equal(execution?.error, 'PROACTIVE_GROUP_DISABLED', 'typed group refusal, not a generic contract error');
  assert.equal(execution?.receiptRecording, 'failed');
  assert.equal(persisted.receipt?.id, 'host-action:' + action.id);
  const receiptBody = JSON.parse(f.service.store.read(persisted.receipt.id).body);
  assert.equal(receiptBody.transportInvoked, false, 'failed receipt proves no transport');
});

test('E2E-L: UNKNOWN send outcome is not retried by the server', async t => {
  const f = await proactiveService(t);
  f.state.plan = proactiveOutput('qq/private/7');
  f.steps.push({throw: Object.assign(new Error('synthetic unknown send'), {code: 'SEND_UNKNOWN'})});
  const first = await say(f.service, 'e2e-l1');
  assert.equal(first.ok, true);
  const action = [...f.service.store.all('action')][0];
  const firstStatus = f.service.store.read(action.id).status;
  assert.equal(firstStatus, 'interrupted', 'an UNKNOWN transport outcome is not recorded as success');
  assert.equal(f.sent.length, 1);
  const receiptCount = [...f.service.store.all('event')].filter(event => event.id === 'host-action:' + action.id).length;
  assert.equal(receiptCount, 1);
  // Re-dispatching the same action is refused before claim/send and does not overwrite UNKNOWN.
  const retry = await f.service.dispatch([{kind: 'act', tool: 'proactive_contact',
    action: {id: action.id, revision: f.service.store.read(action.id).revision}, scene: 'qq/private/7'}],
  {scene: 'qq/private/7', execute: true});
  assert.equal(f.sent.length, 1, 'no automatic resend of an UNKNOWN proactive send');
  assert.equal(f.service.store.read(action.id).status, 'interrupted');
  assert.equal(retry[0]?.error?.code, 'PROACTIVE_HOST_STATE');
  assert.equal([...f.service.store.all('event')].filter(event => event.id === 'host-action:' + action.id).length, 1,
    'the UNKNOWN receipt is not overwritten by a retry');
});

// ---- P2 fail-closed: a ledger row whose Decision references a missing Action/Response is an
// incomplete ledger. server.mjs guard (current tree L622-631) throws PROACTIVE_LEDGER_INCOMPLETE
// (transportInvoked:false) before any claim/send/model; it must never be silently uncounted. ----
function seedLedgerRow(service, {eventId, decisionId, actionId = null, selectedKind = 'act',
  args = {targetScene: 'qq/private/7', text: '在吗'}}) {
  const workspace = [...service.store.all('workspace')][0];
  const eventRef = {id: eventId, revision: 1};
  service.store.execute({requestId: 'e2e-seed-event:' + eventId, commands: [
    {op: 'append_event', id: eventId, body: '合成种子事件', origin: 'reported', actor: 'synthetic',
      scene: 'qq/private/7', source: {system: 'fixture', key: eventId}, occurredAt: PROACTIVE_TEST_T},
    {op: 'admit_subject_event', subjectId: 'jingyang', event: eventRef}]});
  let actionRef = null;
  if (actionId !== null) {
    service.store.execute({requestId: 'e2e-seed-action:' + actionId, commands: [
      {op: 'propose_action', id: actionId, workspace: {id: workspace.id, revision: workspace.revision},
        tool: 'proactive_contact', args, inputRefs: [eventRef]}]});
    actionRef = {id: actionId, revision: 1};
  }
  service.store.execute({requestId: 'e2e-seed-decision:' + decisionId, commands: [
    {op: 'record_decision', id: decisionId, currentEvent: eventRef,
      workspace: {id: workspace.id, revision: workspace.revision}, materials: [],
      input: {payload: {}},
      output: {summary: '合成种子决策', options: [{id: 'o', kind: selectedKind,
        payload: selectedKind === 'act' ? {tool: 'proactive_contact', args} : {text: '合成回复'}}], selected: 'o'},
      ...(actionRef ? {action: actionRef} : {})}]});
  return actionRef;
}

test('E2E-M: dangling Action/Response ledger references fail closed before claim/send/model', async t => {
  // Case 1: a prior Decision selected a respond but its persisted Response record is missing.
  const f = await proactiveService(t);
  await say(f.service, 'e2e-m1'); // establish subject/workspace and one authorized send
  assert.equal(f.sent.length, 1);
  seedLedgerRow(f.service, {eventId: 'obs:e2e-m:respond', decisionId: 'decision:e2e-m:respond', selectedKind: 'respond'});
  const respondCurrent = seedLedgerRow(f.service, {eventId: 'obs:e2e-m:current',
    decisionId: 'decision:e2e-m:current', actionId: 'action:e2e-m:current'});
  const callsBefore = f.state.calls;
  const blocked = await f.service.dispatch([{kind: 'act', tool: 'proactive_contact',
    action: respondCurrent, scene: 'qq/private/7'}], {scene: 'qq/private/7', execute: true});
  assert.equal(blocked[0]?.error?.code, 'PROACTIVE_LEDGER_INCOMPLETE',
    'a missing respond Response makes the ledger incomplete');
  assert.equal(f.sent.length, 1, 'no external send on an incomplete ledger');
  assert.equal(f.state.calls, callsBefore, 'ledger refusal makes no model call');
  const failedRespondAction = f.service.store.read(respondCurrent.id);
  assert.equal(failedRespondAction.status, 'failed');
  assert.equal(failedRespondAction.claimId ?? null, null, 'no claim on an incomplete ledger');
  const respondBody = JSON.parse(f.service.store.read(failedRespondAction.receipt.id).body);
  assert.equal(respondBody.transportInvoked, false, 'failed receipt proves no transport');

  // Case 2: a prior Decision references an Action the store no longer returns (dangling ref).
  const g = await proactiveService(t);
  await say(g.service, 'e2e-m2');
  assert.equal(g.sent.length, 1);
  seedLedgerRow(g.service, {eventId: 'obs:e2e-m:prior-action', decisionId: 'decision:e2e-m:prior-action',
    actionId: 'action:e2e-m:prior-action'});
  const actionCurrent = seedLedgerRow(g.service, {eventId: 'obs:e2e-m:second-current',
    decisionId: 'decision:e2e-m:second-current', actionId: 'action:e2e-m:second-current'});
  const realRead = g.service.store.read.bind(g.service.store);
  const lostActionId = 'action:e2e-m:prior-action';
  // Inject the storage-loss shape the guard is meant to fail closed on.
  g.service.store.read = (id, revision) => id === lostActionId ? null : realRead(id, revision);
  let actionBlocked;
  try {
    actionBlocked = await g.service.dispatch([{kind: 'act', tool: 'proactive_contact',
      action: actionCurrent, scene: 'qq/private/7'}], {scene: 'qq/private/7', execute: true});
  } finally {
    g.service.store.read = realRead;
  }
  assert.equal(actionBlocked[0]?.error?.code, 'PROACTIVE_LEDGER_INCOMPLETE',
    'a dangling ledger Action reference makes the ledger incomplete');
  assert.equal(g.sent.length, 1, 'no external send when a ledger Action reference is dangling');
  const failedAction = g.service.store.read(actionCurrent.id);
  assert.equal(failedAction.status, 'failed');
  assert.equal(failedAction.claimId ?? null, null, 'no claim when a ledger Action reference is dangling');
  const actionBody = JSON.parse(g.service.store.read(failedAction.receipt.id).body);
  assert.equal(actionBody.transportInvoked, false, 'failed receipt proves no transport');
});
