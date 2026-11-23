// Phase 3.2 channel control integration (Test Engineer, independent of F).
// Requirement C: all messages are objectively recorded; private messages are subjectively
// visible by default; group traffic stays objective-only; the subject can mute/unmute a
// channel without deleting objective events; the subject can explicitly peek a group
// backlog into current cognition; silence is legal and never forced into a reply.
// No model, no network, no production DB, no QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBrainService} from '../tools/brain-service/server.mjs';

const T = 1794400000000;
const BRAIN = {'x-brain-token': 'brain-token'};
const attention = () => ({processes: [], relations: [], residency: {upsert: [], remove: []}, questions: []});
const respond = p => JSON.stringify({packetId: p.packetId, options: [{id: 'r', kind: 'respond', payload: {text: '合成回复'}}],
  selected: 'r', summary: 'synthetic', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled', attention: attention()}});
const wait = p => JSON.stringify({packetId: p.packetId, options: [{id: 'w', kind: 'wait', payload: {}}],
  selected: 'w', summary: '合成沉默', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled', attention: attention()}});
const act = (tool, args) => p => JSON.stringify({packetId: p.packetId, options: [{id: 'a', kind: 'act', payload: {tool, args}}],
  selected: 'a', summary: 'synthetic', used: [],
  continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled', attention: attention()}});

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jy-p32-channel-'));
  const state = {calls: 0, plan: respond};
  const services = [];
  const options = () => ({port: 0, token: 'brain-token', storePath: join(dir, 'subject.sqlite'),
    stateDirectory: join(dir, 'state'), heartbeatMs: 0, global: true, clock: () => T,
    allowedActionTools: ['channel_control', 'group_peek'],
    decide: p => { state.calls++; return state.plan(p); }});
  const start = async () => { const s = await startBrainService(options()); services.push(s); return s; };
  const stop = async s => { if (s.server.listening) await new Promise(r => s.server.close(r)); s.close(); };
  const post = async (s, path, body) => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {method: 'POST',
      headers: {'content-type': 'application/json', ...BRAIN}, body: JSON.stringify(body)});
    return {status: res.status, body: await res.json()};
  };
  const isolated = async (s, items) => {
    process.env.JY_GROUP_INGEST = 'off';
    try {
      return items.map(item => s.observe({source: 'qq', key: item.key, sourceKey: item.key, text: item.text,
        scene: item.scene, occurredAt: item.at}));
    } finally { delete process.env.JY_GROUP_INGEST; }
  };
  t.after(async () => {
    for (const s of services) { try { await stop(s); } catch {} }
    try { rmSync(dir, {recursive: true, force: true}); } catch {}
  });
  return {dir, state, start, stop, post, isolated};
}

test('private messages are subjectively visible by default and duplicate deliveries ingest once', async t => {
  const f = await fixture(t), s = await f.start();
  const first = await s.reply({scene: 'qq/private/1', key: 'private:1', message_id: 'm1',
    messages: [{role: 'user', content: '合成私聊消息'}]});
  assert.equal(first.ok, true);
  assert.equal(first.silent, false);
  assert.equal(first.text, '合成回复');
  assert.equal(f.state.calls, 1);
  const events = [...s.store.all('event')];
  assert.equal(events.length, 1);
  assert.equal(events[0].body, '合成私聊消息');
  assert.equal(s.store.subjectObservation('jingyang', events[0].id).status, 'handled');

  const duplicate = await s.reply({scene: 'qq/private/1', key: 'private:1', message_id: 'm1',
    messages: [{role: 'user', content: '合成私聊消息'}]});
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.silent, true, 'a duplicate delivery is recorded once and does not re-decide');
  assert.equal(f.state.calls, 1);
  assert.equal([...s.store.all('event')].length, 1);
  assert.equal([...s.store.all('decision')].length, 1);
});

test('group traffic stays objective-only under GROUP_INGEST=off and never wakes the model', async t => {
  const f = await fixture(t), s = await f.start();
  const observed = await f.isolated(s, [
    {key: 'group:7:g1', text: '群消息一', scene: 'qq/group/7', at: T},
    {key: 'group:7:g2', text: '群消息二', scene: 'qq/group/7', at: T + 1}]);
  for (const result of observed) {
    assert.equal(result.queued, false);
    assert.equal(result.muted, true);
    assert.equal(result.reason, 'group-isolated');
  }
  const events = [...s.store.all('event')].filter(e => e.scene === 'qq/group/7');
  assert.deepEqual(events.map(e => e.body).sort(), ['群消息一', '群消息二'].sort(), 'objective events are all recorded');
  for (const event of events)
    assert.equal(s.store.subjectObservation('jingyang', event.id), null, 'isolated group traffic is not admitted to the subject');
  assert.deepEqual(s.attention(), {format: 'attention-policy-v1', prefixes: [], backlog: 2});

  const before = f.state.calls;
  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(f.state.calls, before, 'silence: no model turn is spent on isolated group traffic');
  assert.equal([...s.store.all('decision')].length, 0);
  assert.equal([...s.store.all('response')].length, 0);
});

test('explicit group_peek admits the backlog into current cognition without forcing a reply', async t => {
  const f = await fixture(t), s = await f.start();
  await f.isolated(s, [
    {key: 'group:9:g1', text: '群积压一', scene: 'qq/group/9', at: T},
    {key: 'group:9:g2', text: '群积压二', scene: 'qq/group/9', at: T + 1}]);
  f.state.plan = act('group_peek', {prefix: 'qq/group/9', limit: 10});
  const peeked = await s.reply({scene: 'qq/private/2', key: 'private:2', message_id: 'm2',
    messages: [{role: 'user', content: '看看那个群'}]});
  assert.equal(peeked.ok, true);
  assert.equal(peeked.silent, true, 'a peek is not a reply obligation');
  const action = peeked.outbox.find(o => o.kind === 'act');
  assert.equal(action?.tool, 'group_peek');
  assert.equal(action?.execution?.status, 'succeeded');
  assert.deepEqual(s.attention(), {format: 'attention-policy-v1', prefixes: [], backlog: 0}, 'peek consumes the backlog');
  const groupEvents = [...s.store.all('event')].filter(e => e.scene === 'qq/group/9');
  for (const event of groupEvents) assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');
  const receipt = [...s.store.all('event')].find(e => e.id.startsWith('group-peek:'));
  assert.ok(receipt, 'peek records a host receipt');
  assert.equal(JSON.parse(receipt.body).loaded, 2);
  assert.equal(receipt.body.includes('qq/group/9'), true);
  assert.equal([...s.store.all('response')].length, 0, 'peek must not manufacture a response');

  f.state.plan = wait;
  const before = f.state.calls;
  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(f.state.calls, before + 1);
  assert.equal(turn.silent, true, 'cognition may end in silence');
  const seen = [...s.store.all('decision')].some(d => groupEvents.some(e => d.currentEvent?.id === e.id));
  assert.equal(seen, true, 'a peeked group event enters the next packet as the current event');
});

test('channel mute keeps objective events, suppresses wake, and unmute(load) replays the backlog', async t => {
  const f = await fixture(t), s = await f.start();
  const before = f.state.calls;
  const muted = await f.post(s, '/v1/attention/mute', {prefix: 'qq/private/3'});
  assert.equal(muted.status, 200);
  assert.deepEqual(muted.body.prefixes, ['qq/private/3']);
  assert.deepEqual((await f.post(s, '/v1/attention/mute', {prefix: 'qq/private/3'})).body.prefixes, ['qq/private/3'], 'mute is idempotent');

  const observed = s.observe({source: 'qq', key: 'private:3', sourceKey: 'private:3:m3', text: '被屏蔽的私聊',
    scene: 'qq/private/3', occurredAt: T});
  assert.equal(observed.queued, false);
  assert.equal(observed.muted, true);
  const event = [...s.store.all('event')].find(e => e.scene === 'qq/private/3');
  assert.equal(event.body, '被屏蔽的私聊', 'mute never deletes the objective event');
  assert.equal(s.store.subjectObservation('jingyang', event.id), null, 'a muted channel does not auto-enter cognition');
  assert.deepEqual(s.attention(), {format: 'attention-policy-v1', prefixes: ['qq/private/3'], backlog: 1});
  await s.turn();
  assert.equal(f.state.calls, before, 'muting prevents the model wake');

  const unmuted = await f.post(s, '/v1/attention/unmute', {prefix: 'qq/private/3', load: true});
  assert.equal(unmuted.status, 200);
  assert.deepEqual(unmuted.body.prefixes, []);
  assert.deepEqual(s.attention(), {format: 'attention-policy-v1', prefixes: [], backlog: 0});
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'received');
  f.state.plan = wait;
  const beforeTurn = f.state.calls;
  const turn = await s.turn();
  assert.equal(turn.ok, true);
  assert.equal(turn.item, 'obs:private:3:m3');
  assert.equal(f.state.calls, beforeTurn + 1);
  assert.equal(s.store.subjectObservation('jingyang', event.id).status, 'handled');
});

test('channel_control native action mutes and unmutes a channel with host receipts', async t => {
  const f = await fixture(t), s = await f.start();
  f.state.plan = act('channel_control', {op: 'mute', prefix: 'qq/private/9'});
  const muted = await s.reply({scene: 'qq/private/8', key: 'private:8', message_id: 'm8',
    messages: [{role: 'user', content: '先屏蔽 9 号'}]});
  assert.equal(muted.ok, true);
  const muteAction = muted.outbox.find(o => o.tool === 'channel_control');
  assert.equal(muteAction?.execution?.status, 'succeeded');
  assert.deepEqual(s.attention().prefixes, ['qq/private/9']);
  const muteReceipt = [...s.store.all('event')].find(e => e.id.startsWith('channel-control:'));
  assert.ok(muteReceipt);
  assert.equal(JSON.parse(muteReceipt.body).op, 'mute');
  assert.equal(JSON.parse(muteReceipt.body).prefix, 'qq/private/9');

  const suppressed = s.observe({source: 'qq', key: 'private:9', sourceKey: 'private:9:m9', text: '屏蔽后消息',
    scene: 'qq/private/9', occurredAt: T + 5});
  assert.equal(suppressed.muted, true);
  assert.equal(suppressed.queued, false);

  f.state.plan = act('channel_control', {op: 'unmute', prefix: 'qq/private/9'});
  const unmuted = await s.reply({scene: 'qq/private/10', key: 'private:10', message_id: 'm10',
    messages: [{role: 'user', content: '恢复 9 号'}]});
  assert.equal(unmuted.ok, true);
  assert.deepEqual(s.attention().prefixes, []);
  const reopened = s.observe({source: 'qq', key: 'private:9', sourceKey: 'private:9:m9b', text: '恢复后消息',
    scene: 'qq/private/9', occurredAt: T + 6});
  assert.equal(reopened.queued, true, 'unmuted channel is subjectively visible again');
  const receipts = [...s.store.all('event')].filter(e => e.id.startsWith('channel-control:'));
  assert.equal(receipts.length, 2);
});

test('mute and backlog survive a restart without auto-admit or auto-reply', async t => {
  const f = await fixture(t), first = await f.start();
  await f.post(first, '/v1/attention/mute', {prefix: 'qq/private/12'});
  first.observe({source: 'qq', key: 'private:12', sourceKey: 'private:12:m12', text: '重启前的屏蔽消息',
    scene: 'qq/private/12', occurredAt: T});
  const event = [...first.store.all('event')].find(e => e.scene === 'qq/private/12');
  assert.equal(first.store.subjectObservation('jingyang', event.id), null);
  await f.stop(first);

  const second = await f.start();
  assert.deepEqual(second.attention(), {format: 'attention-policy-v1', prefixes: ['qq/private/12'], backlog: 1});
  assert.equal(second.store.subjectObservation('jingyang', event.id), null, 'restart does not auto-admit muted traffic');
  assert.equal(f.state.calls, 0);
  const idle = await second.turn();
  assert.equal(idle.ok, true);
  assert.equal(f.state.calls, 0, 'restart does not spend a model turn on the muted backlog');
  assert.equal([...second.store.all('response')].length, 0);

  f.state.plan = wait;
  const unmuted = await f.post(second, '/v1/attention/unmute', {prefix: 'qq/private/12', load: true});
  assert.equal(unmuted.status, 200);
  const turn = await second.turn();
  assert.equal(turn.ok, true);
  assert.equal(f.state.calls, 1);
  assert.equal(turn.silent, true);
  assert.equal(second.store.subjectObservation('jingyang', event.id).status, 'handled');
});
