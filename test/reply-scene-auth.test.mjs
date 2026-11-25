// Phase 3.2 M2 — IR-02 `/v1/reply` scene / inbound authorization contract (TE-owned new file).
// Contract (Lead-fixed, 2026-11-21): createBrainService option
// `inboundScenePolicy={ownerQQ,allowedGroups:[],groupIngest:'off'|'on',requireToken:boolean}`
// is computed by bootstrap from QQ_OWNER/QQ_ALLOWED_GROUPS/JY_GROUP_INGEST/BRAIN_TOKEN and passed
// in; tests inject the option. `/v1/reply` validates BEFORE observe:
//   missing/wrong protocol -> 400 INBOUND_PROTOCOL
//   token required+missing/wrong -> 401 UNAUTHORIZED
//   malformed scene -> 400 INBOUND_SCENE_FORMAT
//   body.key mismatch -> 400 INBOUND_SCENE_KEY
//   non-owner private / non-whitelist group -> 403 INBOUND_SCENE_NOT_AUTHORIZED
// Every refusal: 0 event / 0 decision / 0 model / 0 send.
// Allowed: only `qq/private/<ownerQQ>`; groups only allowedGroups. Allowed group + groupIngest off
// => objective event recorded, no model wake; groupIngest on => normal path.
// `/v1/observe` is OUT of IR-02 M2 scope (partial, not covered here).
// launchBrain+env is used only by the single bootstrap-wiring test at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {launchBrain, inboundScenePolicy} from '../tools/brain-service/bootstrap.mjs';
import {keepAttention} from '../src/attention.mjs';

const OWNER = '1234567890';
const TOKEN = 'te-ir02-brain-token-0123456789'; // >=16, contract requires a local token when requireToken
const PROTOCOL = 'jingyang-brain-bridge-v1';
const wait = packet => JSON.stringify({packetId: packet.packetId,
  options: [{id: 'w', kind: 'wait', payload: {}}], selected: 'w', summary: 'ir-02 fixture silence', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null,
    observationDisposition: 'handled', attention: keepAttention()}});

function fixture(t, {policy = {}, adapter = null, omitPolicy = false} = {}) {
  const state = {decide: 0, plan: wait, sends: []};
  const options = {
    port: 0, storePath: ':memory:', stateDirectory: null, heartbeatMs: 0, global: true,
    token: policy.requireToken === false ? null : TOKEN,
    ...(omitPolicy ? {} : {inboundScenePolicy: {ownerQQ: OWNER, allowedGroups: [], groupIngest: 'off', requireToken: true, ...policy}}),
    decide: packet => { state.decide++; return state.plan(packet); },
    ...(adapter ? {adapter} : {}),
  };
  const started = {service: null};
  t.after(async () => { if (started.service?.server.listening) await new Promise(r => started.service.server.close(r)); started.service?.close(); });
  return startBrainService(options).then(service => {
    started.service = service;
    return {service, state};
  });
}

const counts = service => ({
  events: [...service.store.all('event')].length,
  decisions: [...service.store.all('decision')].length,
  responses: [...service.store.all('response')].length,
});

async function post(service, body, {token = TOKEN, path = '/v1/reply'} = {}) {
  const headers = {'content-type': 'application/json'};
  if (token !== null) headers['x-brain-token'] = token;
  const response = await fetch(service.url + path, {method: 'POST', headers, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}

const replyBody = (overrides = {}) => ({protocol: PROTOCOL, source: 'qq', key: 'private:' + OWNER,
  scene: 'qq/private/' + OWNER, message_id: 'ir02-1',
  messages: [{role: 'user', content: '合成消息'}], ...overrides});
const groupBody = (groupId, overrides = {}) => ({protocol: PROTOCOL, source: 'qq', key: 'group:' + groupId,
  scene: 'qq/group/' + groupId, message_id: 'ir02-group-' + groupId,
  messages: [{role: 'user', content: '合成群消息'}], ...overrides});

async function expectRefused(t, {body, token = TOKEN, policy = {}, status, error}) {
  const {service, state} = await fixture(t, {policy});
  const before = counts(service);
  const refused = await post(service, body, {token});
  assert.equal(refused.status, status, JSON.stringify(refused.body));
  assert.equal(refused.body.error, error, JSON.stringify(refused.body));
  assert.deepEqual(counts(service), before, `${error} must not write events/decisions/responses`);
  assert.equal(state.decide, 0, `${error} must not call the model`);
  return {service, state, refused};
}

test('IR-02-N1: missing protocol is refused before observe (400 INBOUND_PROTOCOL)', async t => {
  await expectRefused(t, {body: replyBody({protocol: undefined}), status: 400, error: 'INBOUND_PROTOCOL'});
});

test('IR-02-N2: wrong protocol is refused before observe (400 INBOUND_PROTOCOL)', async t => {
  await expectRefused(t, {body: replyBody({protocol: 'other-bridge-v1'}), status: 400, error: 'INBOUND_PROTOCOL'});
});

test('IR-02-N3: required token missing is refused (401 UNAUTHORIZED)', async t => {
  await expectRefused(t, {body: replyBody(), token: null, status: 401, error: 'UNAUTHORIZED'});
});

test('IR-02-N4: wrong token is refused (401 UNAUTHORIZED)', async t => {
  await expectRefused(t, {body: replyBody(), token: 'wrong-token-0123456789', status: 401, error: 'UNAUTHORIZED'});
});

test('IR-02-N5: malformed scene is refused (400 INBOUND_SCENE_FORMAT)', async t => {
  await expectRefused(t, {body: replyBody({scene: 'qq/private/not-a-number', key: 'private:not-a-number'}),
    status: 400, error: 'INBOUND_SCENE_FORMAT'});
});

test('IR-02-N6: body.key not matching scene is refused (400 INBOUND_SCENE_KEY)', async t => {
  await expectRefused(t, {body: replyBody({key: 'private:999999'}), status: 400, error: 'INBOUND_SCENE_KEY'});
});

test('IR-02-N7: a private scene that is not the owner is refused (403 INBOUND_SCENE_NOT_AUTHORIZED)', async t => {
  const other = '7777777777';
  await expectRefused(t, {body: replyBody({scene: 'qq/private/' + other, key: 'private:' + other}),
    status: 403, error: 'INBOUND_SCENE_NOT_AUTHORIZED'});
});

test('IR-02-N8: a group outside the whitelist is refused with no event (403 INBOUND_SCENE_NOT_AUTHORIZED)', async t => {
  await expectRefused(t, {body: groupBody('987654321'), status: 403, error: 'INBOUND_SCENE_NOT_AUTHORIZED'});
});

test('IR-02-P1: owner private message passes and continues observe->turn->silence without sending', async t => {
  const sends = [];
  const {service, state} = await fixture(t, {adapter: {send: async input => { sends.push(input); return {delivered: true}; }}});
  const before = counts(service);
  const accepted = await post(service, replyBody({message_id: 'ir02-owner-1'}));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body?.ok, true);
  assert.equal(state.decide, 1, 'the authorized message reaches the model turn');
  const after = counts(service);
  assert.equal(after.events, before.events + 1, 'exactly one objective event is recorded');
  assert.equal(after.decisions, before.decisions + 1, 'the turn produces one decision');
  assert.equal(after.responses, before.responses, 'a wait decision creates no response');
  assert.equal(sends.length, 0, 'silence sends nothing');
  assert.equal(accepted.body.silent, true);
});

test('IR-02-P2: allowed group with groupIngest=off is objective-only and never wakes the model', async t => {
  const {service, state} = await fixture(t, {policy: {allowedGroups: ['555000111'], groupIngest: 'off'}});
  const before = counts(service);
  const accepted = await post(service, groupBody('555000111'));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(state.decide, 0, 'an isolated group message must not wake the model');
  const after = counts(service);
  assert.equal(after.events, before.events + 1, 'the objective group event is still recorded');
  assert.equal(after.decisions, before.decisions, 'no decision is produced for objective-only traffic');
  const event = [...service.store.all('event')].find(record => record.scene === 'qq/group/555000111');
  assert.ok(event, 'objective event exists');
  assert.equal(service.store.subjectObservation('jingyang', event.id), null,
    'objective-only group traffic is not admitted to the subject inbox');
});

test('IR-02-P3: allowed group with groupIngest=on follows the normal decision path', async t => {
  const {service, state} = await fixture(t, {policy: {allowedGroups: ['555000111'], groupIngest: 'on'}});
  const accepted = await post(service, groupBody('555000111'));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(state.decide, 1, 'ingest-on group traffic reaches the model');
  assert.equal([...service.store.all('decision')].length, 1);
});

// ---- bootstrap wiring: `inboundScenePolicy` is computed from existing env and passed to the
// Lead-owned service option (bootstrap.mjs `inboundScenePolicy` L25-31 / pass-through L351). ----
function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jy-ir02-wiring-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function fakeCore(captured) {
  return {READ_ONLY_HOST_TOOLS: [], async startBrainService(options) {
    captured.options = options;
    return {server: {listening: false}, port: 0, url: 'http://offline', token: null,
      store: {recordDiagnostic: () => ({logged: true}), read: () => null, all: () => []},
      health: () => ({cognitionBusy: false, active: null, pending: []}), close() {},
      stopScheduling() {}, beginShutdown() {}, startScheduling() {}, runCognitionExclusive: async fn => fn()};
  }};
}
test('IR-02-W1: launchBrain computes inboundScenePolicy from existing env and passes it to the service', async t => {
  const state = tempRoot(t), captured = {};
  const token = 't'.repeat(24);
  const running = await launchBrain({root: process.cwd(), env: {
    BRAIN_STORE: join(state, 'subject.sqlite'), BRAIN_STATE: join(state, 'state'),
    BRAIN_STYLE_DIR: join(state, 'style'), JY_AFFECT: '0',
    QQ_OWNER: '10001', QQ_ALLOWED_GROUPS: '20002,20003', JY_GROUP_INGEST: 'off',
    BRAIN_TOKEN: token, JY_REQUIRE_BRAIN_TOKEN: '1'}, dependencies: {core: fakeCore(captured)}});
  t.after(async () => { try { await running.stop(); } catch {} });
  const policy = captured.options?.inboundScenePolicy;
  assert.ok(policy, 'bootstrap must pass inboundScenePolicy to the service');
  assert.deepEqual({ownerQQ: policy.ownerQQ, allowedGroups: policy.allowedGroups,
    groupIngest: policy.groupIngest, requireToken: policy.requireToken},
  {ownerQQ: '10001', allowedGroups: ['20002', '20003'], groupIngest: 'off', requireToken: true});
  assert.equal(captured.options.token, token);
  // Pure helper is the same source of truth (no new env key); `mode`/`allowAllPrivate`
  // belong to the Lead-fixed policy shape (allowAllPrivate only when QQ_CHAT_SCOPE==='all').
  assert.deepEqual(inboundScenePolicy({env: {QQ_TEST_ONLY_OWNER: '500', QQ_ALLOWED_GROUPS: '7, 7', JY_GROUP_INGEST: 'on'}}),
    {mode: 'enforce', ownerQQ: '500', allowedGroups: ['7'], groupIngest: 'on', requireToken: false, allowAllPrivate: false});
  assert.deepEqual(inboundScenePolicy({env: {QQ_OWNER: '10001', QQ_CHAT_SCOPE: 'all'}}),
    {mode: 'enforce', ownerQQ: '10001', allowedGroups: [], groupIngest: 'on', requireToken: false, allowAllPrivate: true});
});

// ---- compatibility: no inboundScenePolicy option => legacy permissive ingress (existing
// fixtures/tests keep working; IR-02 enforcement is opt-in through the Lead-owned option). ----
test('IR-02-COMPAT: no inboundScenePolicy keeps legacy permissive /v1/reply behaviour', async t => {
  const {service, state} = await fixture(t, {omitPolicy: true, policy: {requireToken: false}});
  const before = counts(service);
  const accepted = await post(service, replyBody({protocol: undefined, message_id: 'ir02-legacy-1'}), {token: null});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(state.decide, 1, 'legacy ingress still reaches the model turn');
  assert.equal(counts(service).events, before.events + 1);
  assert.equal(counts(service).decisions, before.decisions + 1);
});

// ---- IR-02 M5 mode 2: another private friend is allowed when policy.allowAllPrivate===true
// (derived by bootstrap from QQ_CHAT_SCOPE==='all'; owner always allowed; groups stay whitelist). ----
test('IR-02-M5: allowAllPrivate permits another private friend while groups stay whitelist-only', async t => {
  // Mode 2: allowAllPrivate=true -> any qq/private/<digits> allowed with token/key.
  const {service, state} = await fixture(t, {policy: {requireToken: true, allowAllPrivate: true, allowedGroups: ['555000111']}});
  const other = '7777777777';
  const accepted = await post(service, replyBody({scene: 'qq/private/' + other, key: 'private:' + other}));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(state.decide, 1);
  const owner = await post(service, replyBody({message_id: 'ir02-m5-owner'}));
  assert.equal(owner.status, 200, 'owner private is always allowed');
  // Groups remain whitelist-only even with allowAllPrivate=true.
  const group = await post(service, groupBody('987654321'));
  assert.equal(group.status, 403);
  assert.equal(group.body.error, 'INBOUND_SCENE_NOT_AUTHORIZED');
  const whitelistedGroup = await post(service, groupBody('555000111'));
  assert.equal(whitelistedGroup.status, 200);
});
