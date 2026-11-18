import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityStore } from '../src/store.mjs';
import { ContinuitySession } from '../src/continuity-session.mjs';
import { TurnDriver } from '../src/turn-driver.mjs';
import { createModelDecision } from '../src/model-transport.mjs';
import { ensurePerson } from '../src/identity.mjs';
import { intentEligible, intentPacket, verifiedIntent } from '../src/intent-protocol.mjs';
import { MaintenanceSession } from '../src/maintenance.mjs';
import { startBrainService } from '../tools/brain-service/server.mjs';
import { keepAttention } from '../src/attention.mjs';
import { affectFactory } from '../tools/affect-integrated/session.mjs';
import { isGroupAddressed, acceptsChat, blockedChatSet } from '../tools/qq-connect/scope.mjs';
import { createOpenLifeHost } from '../tools/open-life/host.mjs';
import { boundedTimeline } from '../src/cognition.mjs';
import { put, event, frame, note, ref } from './helpers.mjs';

test('intent view aggregates person, cross-session metadata, relative times, speaker names, and private boundaries', t => {
  const now = Date.now();
  const store = new ContinuityStore(':memory:', { clock: () => now - 40 * 60_000 });
  t.after(() => store.close());
  const session = new ContinuitySession({ store, subjectId: 'jingyang', attention: true });
  const sender = ensurePerson(store, { system: 'qq', id: '100001', name: '测试同学', isOwner: true });
  const otherPrivate = ensurePerson(store, { system: 'qq', id: '888', name: '小李' });
  const otherGroup = ensurePerson(store, { system: 'qq', id: '777', name: '大王' });

  const w = put(store, 'ws', frame())[0];
  // 1. Private message 40 minutes ago + her private reply + anchored note from that private message.
  const privMsg = put(store, 'priv1', event('priv-1', {
    body: '私聊秘密：我其实下周要去上海出差',
    scene: 'qq/private/100001',
    actor: sender.entityId,
    sender,
    occurredAt: now - 40 * 60_000,
  })).at(-1);
  const p0 = session.prepare({ currentEvent: ref(privMsg), workspace: ref(w), identity: '你是鲸漾。', mind: true, unified: true, workbenchMaterials: true, workbenchFocus: true, workbenchRecovery: true, taskThreads: true, localLookupPolicy: { maxReads: 2, maxHits: 4 }, budgetBytes: 131072, now: now - 40 * 60_000 });
  session.commit({
    packet: p0, decisionId: 'd-priv', requestId: 'd-priv', allowedActionTools: [],
    output: {
      packetId: p0.packetId,
      options: [{ id: 'r', kind: 'respond', payload: { text: '好，上海出差我记在心里不外传' } }],
      selected: 'r', summary: '私聊回应', used: [],
      continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
    },
  });
  store.execute({
    requestId: 'mark-sent',
    commands: [
      { op: 'claim_response', response: { id: 'd-priv:response', revision: 1 }, claimId: 'c1', worker: 'qq' },
      { op: 'record_response_delivery', response: { id: 'd-priv:response', revision: 2 }, claimId: 'c1', outcome: 'sent', eventId: 'ev-sent', body: 'ok', source: { system: 'qq', key: 'sent1' }, actor: 'qq' },
    ],
  });
  put(store, 'priv-note', note('note-shanghai', [ref(privMsg)], {
    body: '测试同学下周去上海出差',
    anchor: { kind: 'entity', id: sender.entityId },
  }));

  // 2. Unhandled messages in two other scenes (elsewhere) — bodies MUST NOT leak into view.elsewhere.
  const waitPriv = put(store, 'wait-priv', event('wp1', {
    body: '绝密正文不应该进elsewhere', scene: 'qq/private/888', actor: otherPrivate.entityId, sender: otherPrivate, occurredAt: now - 40 * 60_000,
  })).at(-1);
  store.execute({ requestId: 'admit-wp', commands: [{ op: 'admit_subject_event', subjectId: 'jingyang', event: ref(waitPriv) }] });
  for (let i = 1; i <= 2; i++) {
    const wg = put(store, 'wait-grp-' + i, event('wg' + i, {
      body: '群消息正文' + i, scene: 'qq/group/777', actor: otherGroup.entityId, sender: otherGroup, occurredAt: now - (6 - i) * 60_000,
    })).at(-1);
    store.execute({ requestId: 'admit-wg-' + i, commands: [{ op: 'admit_subject_event', subjectId: 'jingyang', event: ref(wg) }] });
  }

  // 3. Prior message in group 999 3 minutes ago, and current message now.
  const grpPrev = put(store, 'grp-prev', event('gp1', {
    body: '大家晚上吃什么', scene: 'qq/group/999', actor: sender.entityId, sender, occurredAt: now - 3 * 60_000,
  })).at(-1);
  store.execute({ requestId: 'admit-gp1', commands: [{ op: 'admit_subject_event', subjectId: 'jingyang', event: ref(grpPrev) }] });
  const grpCur = put(store, 'grp-cur', event('gc1', {
    body: '对了，我下周打算去哪来着？', scene: 'qq/group/999', actor: sender.entityId, sender, occurredAt: now,
  })).at(-1);

  const packet = session.prepare({
    currentEvent: ref(grpCur), workspace: ref(w), identity: '你是鲸漾。',
    mind: true, unified: true, workbenchMaterials: true, workbenchFocus: true, workbenchRecovery: true, taskThreads: true,
    localLookupPolicy: { maxReads: 2, maxHits: 4 }, socialContext: true, budgetBytes: 131072, now,
  });
  const wire = intentPacket(packet);
  assert.doesNotThrow(() => verifiedIntent(wire));
  assert.doesNotMatch(wire.messages[1].content, /revision|expectedRevision|attention:/);

  const view = JSON.parse(wire.messages[1].content).view;
  assert.equal(view.current.from, '测试同学');
  assert.equal(view.current.ago, '刚刚');
  assert.equal(view.current.pendingInChat, 1);
  assert.equal(view.recent[0].who, '测试同学');
  assert.equal(view.recent[0].ago, '3分钟前');
  assert.equal(view.lastAction.ago, '40分钟前');

  // Person perspective + privacy tags
  assert.equal(view.person.who.name, '测试同学');
  assert.equal(view.person.who.isOwner, true);
  assert.equal(view.person.knowledge[0].privateOnly, true);
  assert.equal(view.person.knowledge[0].fromScene, 'qq/private/100001');
  assert.ok(view.person.crossSession.some(c => c.where === 'qq/private/100001' && c.privateOnly === true && c.ago === '40分钟前'));
  assert.match(view.person.privacyNotice, /privateOnly/);

  // Elsewhere: metadata only, NO leaked body text
  assert.equal(view.elsewhere.length, 2);
  assert.equal(view.elsewhere[0].where, 'qq/private/888');
  assert.equal(view.elsewhere[0].pendingCount, 1);
  assert.equal(view.elsewhere[0].waiting, '40分钟');
  assert.equal(view.elsewhere[0].private, true);
  assert.deepEqual(view.elsewhere[0].from, ['小李']);
  assert.equal(view.elsewhere[1].where, 'qq/group/777');
  assert.equal(view.elsewhere[1].pendingCount, 2);
  assert.doesNotMatch(JSON.stringify(view.elsewhere), /绝密正文|群消息正文/);
});

test('TurnDriver with runtimeFeedback uses intent-v1 when intentProtocol is enabled', async t => {
  const store = new ContinuityStore(':memory:');
  t.after(() => store.close());
  const dir = mkdtempSync(join(tmpdir(), 'jy-td-intent-'));
  const w = put(store, 'ws', frame())[0];
  const sent = [];
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages);
    const { packetId, view } = JSON.parse(body.messages.at(-1).content);
    assert.equal(view.current.from, '测试同学');
    assert.equal(view.sendScope.recipient, '100001');
    return new Response(JSON.stringify({
      id: 'resp1', created: 1, model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ packetId, decision: { type: 'reply', text: '收到啦' } }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const model = createModelDecision({
    ledgerPath: join(dir, 'journal.json'),
    getKey: () => 'sk-abcdefghijklmnop',
    networkCheck: async () => ({ ok: true }),
    transport,
    profile: { dailyMicros: 1000000, formatRecovery: true, intentProtocol: true },
  });
  t.after(() => model.close());
  model.decide.operationPolicy = { externalSend: { target: 'private', recipient: '100001' } };
  const driver = new TurnDriver({
    store, subjectId: 'jingyang', workspace: ref(w), decide: model.decide, eventBypass: true,
    allowedActionTools: ['anchor_recall'],
  });
  const sender = ensurePerson(store, { system: 'qq', id: '100001', name: '测试同学', isOwner: true });
  driver.ingest({ key: 'm1', body: '在吗', actor: sender.entityId, sender, scene: 'qq/private/100001' });
  const r = await driver.tick({ now: 1_800_000_000_000 });
  assert.equal(r.action, 'decided');
  assert.equal(r.outbox[0].text, '收到啦');
  assert.equal(sent.length, 1);
  assert.ok(sent[0][0].content.includes('view.person'));
});

test('brain-service processes local act tool_receipt promptly without maintenance swallowing it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-act-followup-'));
  let calls = 0;
  const s = await startBrainService({
    port: 0, storePath: join(dir, 's.sqlite'), stateDirectory: join(dir, 'state'),
    global: true, heartbeatMs: 50, allowedActionTools: ['anchor_recall'],
    decide: p => {
      calls++;
      if (calls === 1) {
        return JSON.stringify({
          packetId: p.packetId,
          options: [{ id: 'a', kind: 'act', payload: { tool: 'anchor_recall', args: { anchor: { kind: 'entity', id: 'person:qq:100001' } } } }],
          selected: 'a', summary: '先查记忆', used: [],
          continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
        });
      }
      return JSON.stringify({
        packetId: p.packetId,
        options: [{ id: 'r', kind: 'respond', payload: { text: '查完了，暂时没有旧记忆' } }],
        selected: 'r', summary: '根据回执回复', used: [],
        continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
      });
    },
    adapter: { act: async () => ({ format: 'anchor-query-v1', count: 0, records: [] }), send: async () => ({ delivered: true }) },
  });
  t.after(async () => { await new Promise(r => s.server.close(r)); s.close(); });

  // Verify MaintenanceSession never steals unhandled tool_receipt from inbox.
  const maint = new MaintenanceSession({ store: s.store, subjectId: 'jingyang', identity: '你是鲸漾。' });

  const r1 = await s.reply({
    scene: 'qq/private/100001', key: 'private:100001', message_id: 'm1',
    sender: { system: 'qq', id: '100001', name: '测试同学', isOwner: true },
    messages: [{ role: 'user', content: '看看你有什么记忆' }],
  });
  assert.equal(r1.ok, true);

  // Immediately inspect maintenance: it must not pull the pending tool_receipt into inbox lane.
  const m = maint.inspect();
  assert.notEqual(m.job?.packet?.payload?.pendingObservations?.length, 1);

  // Wait briefly for the scheduled 25ms follow-up tick to process the tool_receipt and send the reply.
  const deadline = Date.now() + 3000;
  let sentResp = null;
  while (Date.now() < deadline) {
    sentResp = [...s.store.all('response')].find(x => x.status === 'sent');
    if (sentResp) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(sentResp, 'expected follow-up reply after tool_receipt');
  assert.equal(sentResp.body, '查完了，暂时没有旧记忆');
  assert.equal(calls, 2);
});

test('intent-v1 exposes recentTools, full memory stack, and bridges moodEval into AffectFusion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-intent-affect-'));
  const store = new ContinuityStore(join(dir, 's.sqlite'));
  t.after(() => store.close());
  const w = store.execute({
    requestId: 'ws-priv',
    commands: [{
      op: 'set_workspace', id: 'ws:qq/private/100001', expectedRevision: 0,
      scene: 'qq/private/100001', focus: { id: 'current', label: '当前' },
      workingRefs: [], continuityRefs: [], actionRefs: [],
    }],
  }).at(-1);
  const sender = ensurePerson(store, { system: 'qq', id: '100001', name: '测试同学', isOwner: true });
  const fac = affectFactory({ fusion: true });
  const session = fac({ store, subjectId: 'jingyang', attention: true, maxForeground: 16 });

  // Seed an earlier tool receipt 1 minute ago in the same scene so recentTools picks it up.
  const prevAct = store.execute({
    requestId: 'seed-act',
    commands: [{
      op: 'propose_action', id: 'act-seed', workspace: ref(w), tool: 'qq_list_friends', args: {}, inputRefs: [],
    }],
  })[0];
  store.execute({
    requestId: 'seed-rcpt',
    commands: [{
      op: 'record_receipt', actionId: prevAct.id, expectedRevision: prevAct.revision,
      status: 'succeeded', eventId: 'rcpt-seed', body: '[{"user_id":100002,"nickname":"好友B"}]',
      source: { system: 'host', key: 'rcpt-seed' }, actor: 'host', occurredAt: Date.now() - 60_000,
    }],
  });
  const prevReceipt = store.read('rcpt-seed');
  // Seed an anchored note + a skill experience note so anchorDirectory & experienceLearning appear in view.
  put(store, 'seed-note', note('note-yy', [], {
    body: '好友B 是测试同学的好友',
    anchor: { kind: 'entity', id: sender.entityId },
  }));

  const ev1 = put(store, 'ev1', event('m1', { body: '帮我发消息给好友B', scene: 'qq/private/100001', actor: sender.entityId, sender })).at(-1);
  store.execute({ requestId: 'admit-1', commands: [{ op: 'admit_subject_event', subjectId: 'jingyang', event: ref(ev1) }] });
  const packet = await session.prepare({
    currentEvent: ref(ev1), workspace: ref(w), identity: '你是鲸漾。',
    instructionSuffix: '【记忆调用与认识范围】\n目录不等于已读正文。',
    mind: true, unified: true, workbenchMaterials: true, workbenchFocus: true, workbenchRecovery: true,
    algorithmV011: true, apperceptionV1: true, subjectiveDomains: true, subjectiveMemoryV2: true,
    taskThreads: true, anchorDirectory: true, investigationContinuityV1: true, experienceLearningV1: true,
    localLookupPolicy: { maxReads: 2, maxHits: 4 },
    allowedActionTools: ['qq_send_message'], socialContext: true, budgetBytes: 131072, now: Date.now(),
  });
  assert.equal(intentEligible(packet), true);
  const wire = intentPacket(packet);
  const view = JSON.parse(wire.messages[1].content).view;
  assert.equal(view.canEvaluateMood, true);
  assert.equal(prevReceipt.origin, 'tool_receipt');
  assert.equal(view.recentTools?.length, 1);
  assert.equal(view.recentTools[0].tool, 'qq_list_friends');
  assert.ok(view.anchors?.length >= 1);
  assert.ok(view.reminders?.some(r => r.hint.includes('锚点笔记')));

  const raw = JSON.stringify({
    packetId: wire.packetId,
    summary: '开心回复',
    decision: { type: 'reply', text: '好呀，我现在就能发' },
    moodEval: { meaning: '觉得测试进展顺利很开心', event: 'smooth-test', valence: 0.7, intensity: 0.6, agency: 'other' },
  });
  await session.invoke(packet, () => raw);
  const d = await session.commit({ packet, output: raw, decisionId: 'd-aff-1', requestId: 'd-aff-1', allowedActionTools: ['qq_send_message'] });
  assert.equal(d.output.options[0].payload.text, '好呀，我现在就能发');
  const meanings = [...store.all('extension_record')].filter(r => r.stateType === 'event-meaning');
  assert.equal(meanings.length, 1);
  assert.equal(meanings[0].value.interpretation.integrated_understanding, '觉得测试进展顺利很开心');
});

test('isGroupAddressed enforces all, mentioned, and wake policies cleanly', () => {
  const plainMsg = { message_type: 'group', message: [{ type: 'text', data: { text: '大家好' } }] };
  const wakeMsg = { message_type: 'group', message: [{ type: 'text', data: { text: '鲸漾在吗' } }] };
  const atMsg = { message_type: 'group', message: [{ type: 'at', data: { qq: '100009' } }, { type: 'text', data: { text: ' 看看' } }] };
  assert.equal(isGroupAddressed(plainMsg, { selfId: 100009, policy: 'all' }), true);
  assert.equal(isGroupAddressed(plainMsg, { selfId: 100009, policy: 'mentioned' }), false);
  assert.equal(isGroupAddressed(atMsg, { selfId: 100009, policy: 'mentioned' }), true);
  assert.equal(isGroupAddressed(plainMsg, { selfId: 100009, policy: 'wake', wakeKeywords: ['鲸漾'] }), false);
  assert.equal(isGroupAddressed(wakeMsg, { selfId: 100009, policy: 'wake', wakeKeywords: ['鲸漾'] }), true);
  assert.equal(isGroupAddressed(atMsg, { selfId: 100009, policy: 'wake', wakeKeywords: ['鲸漾'] }), true);
});

test('blockedChatSet and acceptsChat enforce blocked group/private denylist cleanly', () => {
  const blocked = blockedChatSet({ QQ_BLOCKED_GROUPS: '200001, bad', QQ_BLOCKED_CHATS: 'qq/private/999999' });
  assert.equal(acceptsChat({ privateChat: false, userId: '100001', groupId: '200001' }, { scope: 'all', blockedChats: blocked }), false);
  assert.equal(acceptsChat({ privateChat: false, userId: '100001', groupId: '888888' }, { scope: 'all', blockedChats: blocked }), true);
  assert.equal(acceptsChat({ privateChat: true, userId: '999999' }, { scope: 'all', blockedChats: blocked }), false);
  assert.equal(acceptsChat({ privateChat: true, userId: '100001' }, { scope: 'all', blockedChats: blocked }), true);
});

test('createOpenLifeHost initializes persistent policy and sandboxed office workspace', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jy-ol-host-'));
  const host = createOpenLifeHost({
    root: dir,
    stateDirectory: join(dir, 'state'),
    botId: '100009',
    ownerId: '100001',
    onebot: async () => [],
  });
  assert.ok(host.policy);
  assert.equal(host.officeRoot, join(dir, 'state', 'office-workspace'));
});

test('boundedTimeline sheds older foreground thread units and previousDecisions before overflowing', () => {
  const units = Array.from({ length: 12 }, (_, i) => ({ id: 'u-' + i, incoming: { body: 'x'.repeat(2500) } }));
  const data = {
    current: { body: 'hi' },
    previousDecisions: [{ summary: 'p1 ' + 'a'.repeat(4000) }, { summary: 'p2 ' + 'b'.repeat(4000) }],
    continuity: {
      capabilities: { contractVersion: 2 },
      recent: { items: Array.from({ length: 10 }, (_, i) => ({ ref: { id: 'r-' + i, revision: 1 }, text: 'hi' })) },
      threads: { foreground: { id: 'proc-1', history: { units } }, background: [] },
    },
  };
  const instruction = 'i'.repeat(90000);
  const out = boundedTimeline(data, instruction, 131072);
  assert.ok(Buffer.byteLength(JSON.stringify([{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(out) }])) <= 131072);
  assert.ok(out.continuity.threads.foreground.history.units.length < 12);
  assert.equal(out.continuity.threads.foreground.history.budgetDelivery.complete, false);
});

test('TurnDriver recovers cleanly if stale ready lookup activity hits LOOKUP_CONTEXT_MISMATCH', async t => {
  const store = new ContinuityStore(':memory:');
  t.after(() => store.close());
  let w = put(store, 'ws', frame())[0];
  const sender = ensurePerson(store, { system: 'qq', id: '100001', name: '测试同学', isOwner: true });
  let step = 0;
  const driver = new TurnDriver({
    store, subjectId: 'jingyang', workspace: ref(w), identity: '你是鲸漾。',
    taskThreads: true, investigationContinuityV1: true,
    decide: p => {
      step++;
      if (step === 1) {
        return JSON.stringify({
          packetId: p.packetId,
          options: [{ id: 'l', kind: 'lookup', payload: { terms: ['测试'] } }],
          selected: 'l', summary: '查一下', used: [],
          continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
        });
      }
      return JSON.stringify({
        packetId: p.packetId,
        options: [{ id: 'r', kind: 'respond', payload: { text: '收到恢复了' } }],
        selected: 'r', summary: '回复', used: [],
        continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
      });
    },
  });
  driver.ingest({ key: 'm1', body: '第一句', actor: sender.entityId, sender, scene: 'qq/private/100001' });
  await assert.doesNotReject(async () => {
    await driver.tick({ now: Date.now(), eventBypass: true });
  });
  // Second message after a forced stale ready activity must not wedge forever:
  const ws2 = store.execute({
    requestId: 'bump-ws',
    commands: [{ op: 'set_workspace', id: w.id, expectedRevision: w.revision, scene: w.scene, focus: w.focus, workingRefs: [], continuityRefs: [], actionRefs: [] }],
  }).at(-1);
  const actId = 'extension:jingyang:runtime:turn:' + createHash('sha256').update(JSON.stringify({ subject: 'jingyang', workspace: w.id })).digest('hex');
  // Actually inject via driver2 bound to ws2 using an existing lookup_result from ws1
  const lr = [...store.all('lookup_result')][0];
  const actRec = store.read(actId);
  if (lr && actRec) {
    store.execute({
      requestId: 'inject-stale-ready',
      commands: [{
        op: 'put_extension_record', id: actId, owner: 'jingyang', theory: 'runtime', stateType: 'turn-activity',
        schemaVersion: '1', expectedRevision: actRec.revision,
        value: { phase: 'ready', context: { kind: 'decision', now: Date.now(), observation: { eventId: lr.anchor.id }, reason: 'event', step: 1, lookups: [ref(lr)] } },
      }],
    });
  }
  const driver2 = new TurnDriver({
    store, subjectId: 'jingyang', workspace: ref(ws2), identity: '你是鲸漾。',
    taskThreads: true, investigationContinuityV1: true,
    decide: p => JSON.stringify({
      packetId: p.packetId,
      options: [{ id: 'r', kind: 'respond', payload: { text: '恢复后正常回信' } }],
      selected: 'r', summary: '正常回', used: [],
      continuity: { changes: [], residency: { add: [], remove: [] }, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention() },
    }),
  });
  driver2.ingest({ key: 'm2', body: '第二句在不在', actor: sender.entityId, sender, scene: 'qq/private/100001' });
  const r2 = await driver2.tick({ now: Date.now(), eventBypass: true });
  assert.equal(r2.action, 'decided');
  assert.equal(r2.outbox[0].text, '恢复后正常回信');
});
