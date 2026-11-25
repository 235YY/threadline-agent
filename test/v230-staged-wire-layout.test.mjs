import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRE_LAYOUTS,
  resolveWireLayout,
  createSceneWindowTracker,
  buildStagedMessages,
} from '../src/staged-wire-layout.mjs';
import {summarizeRows} from '../tools/ops/compare-wire-layout.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {admitSubjectEvent} from '../src/continuity.mjs';
import {createModelDecision} from '../src/model-transport.mjs';
import {RequestJournal} from '../src/request-journal.mjs';
import {event, frame, memory, put, ref, disk} from './helpers.mjs';

function makeSyntheticTurn({
  packetId,
  scene = 'qq/private/10001',
  recentItems = [],
  states = [{handle: 'S1', kind: 'belief', text: '她喜欢拿铁', status: 'open', ago: '2小时前'}],
  sendScope = {scope: 'only qq/private/10001'},
  materials = [{handle: 'M1', type: 'note', text: '工作台临时笔记'}],
  reminders = [{handle: 'R1', hint: '联想：上周咖啡店'}],
  lookup = {remaining: 2},
  mood = [{name: 'warm', intensity: 0.6}],
  currentText = '今天好累呀',
  currentId = 'ev:cur',
  extraSystemSuffix = '',
  budgetBytes = 65536,
} = {}) {
  const baseInstruction = '你是鲸漾。按 JSON 格式回复，必须原样回传 packetId。';
  const instruction = baseInstruction + extraSystemSuffix;
  const view = {
    you: {id: 'jingyang', name: '鲸漾'},
    style: '自然温柔、像朋友一样聊天',
    tools: [{handle: 'T1', name: 'remember_note', desc: '记一条笔记'}],
    time: {now: '2026-11-24 09:30', sinceLast: '2分钟'},
    current: {handle: 'E0', from: '阿钧', where: scene, kind: 'message', text: currentText},
    recent: recentItems.slice(-12).map(it => ({
      who: it.role === 'user' ? (it.senderName ?? '阿钧') : '你',
      where: it.scene,
      ago: '刚刚',
      text: it.text,
    })),
    states,
    sendScope,
    materials,
    reminders,
    lookup,
    mood,
    attention: {residences: [{handle: 'W1', label: '咖啡话题'}]},
  };
  const wire = {
    stage: 'intent-decision-v1',
    packetId,
    instruction,
    budgetBytes,
    messages: [
      {role: 'system', content: instruction},
      {role: 'user', content: JSON.stringify({packetId, view})},
    ],
  };
  const packet = {
    packetId,
    payload: {
      current: {id: currentId, revision: 1, scene, body: currentText},
      materials: [{ref: {id: 'note:1', revision: 1}, record: {type: 'note', body: '工作台临时笔记'}}],
      continuity: {
        subject: {id: 'jingyang'},
        recent: {items: recentItems},
      },
    },
  };
  return {wire, packet};
}

test('resolveWireLayout defaults to legacy (OFF)', () => {
  assert.deepEqual(WIRE_LAYOUTS, ['legacy', 'staged-v1']);
  assert.equal(resolveWireLayout(undefined), 'legacy');
  assert.equal(resolveWireLayout(null), 'legacy');
  assert.equal(resolveWireLayout('unknown'), 'legacy');
  assert.equal(resolveWireLayout('staged-v1'), 'staged-v1');
});

test('staged-v1 preserves byte-identical Layer 0 + append-only Layer 1 across multi-turn QQ chat and moves packetId to the end', () => {
  const tracker = createSceneWindowTracker();

  const hist1 = [
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '早安', at: 1000, ref: {id: 'e1', revision: 1}},
    {role: 'her', scene: 'qq/private/10001', text: '早呀！', at: 1005, ref: {id: 'r1', revision: 1}},
  ];
  const t1 = makeSyntheticTurn({
    packetId: 'pkt_turn_1',
    recentItems: hist1,
    currentText: '今天想喝咖啡',
    currentId: 'e2',
    extraSystemSuffix: '\n\n查阅结果在 lookup.done。found 是这页匹配数。',
  });
  const res1 = buildStagedMessages({...t1, tracker});
  assert.equal(res1.applied, true);
  assert.equal(res1.wireLayout, 'staged-v1');
  assert.equal(res1.meta.layer1Count, 2);

  // Turn 2: appends 2 new dialogue messages, changes personal_state, sendScope, mood, reminders, materials, AND removes system suffix.
  const hist2 = [
    ...hist1,
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '今天想喝咖啡', at: 2000, ref: {id: 'e2', revision: 1}},
    {role: 'her', scene: 'qq/private/10001', text: '来杯热拿铁吧', at: 2005, ref: {id: 'r2', revision: 1}},
  ];
  const t2 = makeSyntheticTurn({
    packetId: 'pkt_turn_2',
    recentItems: hist2,
    states: [{handle: 'S1', kind: 'belief', text: '她其实最近改喝美式了', status: 'open', ago: '刚刚'}],
    sendScope: {scope: 'revoked'},
    materials: [{handle: 'M1', type: 'note', text: '全新的检索结果'}],
    reminders: [{handle: 'R1', hint: '新联想：美式咖啡豆'}],
    mood: [{name: 'curious', intensity: 0.8}],
    currentText: '其实我最近改喝美式了',
    currentId: 'e3',
    extraSystemSuffix: '',
  });
  const res2 = buildStagedMessages({...t2, tracker});
  assert.equal(res2.applied, true);

  // 1) Layer 0 system prompt must be 100% byte-identical across Turn 1 and Turn 2!
  assert.equal(res1.messages[0].content, res2.messages[0].content);
  assert.ok(res1.messages[0].content.includes('[STABLE_CONTEXT]'));
  assert.ok(!res1.messages[0].content.includes('pkt_turn_1'));
  assert.ok(!res1.messages[0].content.includes('查阅结果在 lookup.done'));

  // 2) Layer 1 must be strictly append-only (Turn 2 starts with Turn 1's exact Layer 1 messages)!
  assert.equal(res2.meta.layer1Count, 4);
  assert.deepEqual(res2.messages.slice(1, 3), res1.messages.slice(1, 3));

  // 3) Transient reminders/materials/states must NEVER leak into Layer 1!
  const layer1Text = res2.messages.slice(1, 5).map(m => m.content).join('\n');
  assert.ok(!layer1Text.includes('工作台临时笔记'));
  assert.ok(!layer1Text.includes('联想：上周咖啡店'));
  assert.ok(!layer1Text.includes('pkt_turn_1'));

  // 4) Layer 2 must immediately reflect updated personal_state & revoked sendScope, with packetId LAST!
  const l2Raw = res2.messages.at(-1).content;
  assert.ok(l2Raw.endsWith('"packetId":"pkt_turn_2"}'), `expected packetId at end, got tail: ${l2Raw.slice(-60)}`);
  const l2 = JSON.parse(l2Raw);
  assert.equal(l2.packetId, 'pkt_turn_2');
  assert.equal(l2.states[0].text, '她其实最近改喝美式了');
  assert.equal(l2.sendScope.scope, 'revoked');
  assert.equal(l2.reminders[0].hint, '新联想：美式咖啡豆');
  assert.equal(l2.attention.residences[0].handle, 'W1');
  assert.equal(l2.recent, undefined);
  assert.equal(l2.you, undefined);
  assert.equal(l2.tools, undefined);
});

test('staged identity and style stay at the front when the effective tool grant changes',()=>{
 const first=makeSyntheticTurn({packetId:'first'});
 const second=makeSyntheticTurn({packetId:'second',scene:'qq/group/2'});
 const edited=JSON.parse(second.wire.messages[1].content);
 edited.view.tools=[{handle:'T1',name:'read_only',desc:'只读能力'}];
 second.wire.messages[1].content=JSON.stringify(edited);
 const a=buildStagedMessages(first),b=buildStagedMessages(second);
 const prefix=a.messages[0].content.split('"tools":')[0];
 assert.match(prefix,/鲸漾/);
 assert.match(prefix,/自然温柔/);
 assert.ok(b.messages[0].content.startsWith(prefix));
 assert.match(b.messages[0].content,/read_only/);
 assert.doesNotMatch(b.messages[0].content,/remember_note/);
 const archived=buildStagedMessages({...first,options:{legacyStableProfileOrder:true}});
 assert.equal(archived.meta.variant,'intent-staged-v1');
 assert.ok(archived.messages[0].content.indexOf('"tools":')<archived.messages[0].content.indexOf('"you":'));
});

test('QQ scene isolation and batch-window rollover (no 1-by-1 shift)', () => {
  const tracker = createSceneWindowTracker();
  const opts = {maxHistoryTurns: 6, retainOnRoll: 3, maxHistoryBytes: 8000};

  // Build 6 items in private chat A
  const itemsA = Array.from({length: 6}, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'her',
    scene: 'qq/private/10001',
    senderName: '阿钧',
    text: `私聊消息 ${i + 1}`,
    at: 1000 + i * 10,
    ref: {id: `a${i + 1}`, revision: 1},
  }));
  const rA1 = buildStagedMessages({...makeSyntheticTurn({packetId: 'pA1', scene: 'qq/private/10001', recentItems: itemsA}), tracker, options: opts});
  assert.equal(rA1.meta.layer1Count, 6);
  assert.equal(rA1.meta.rolled, false);
  assert.equal(rA1.meta.anchorKey, 'a1@1');

  // Switch to group chat B: completely isolated anchor & messages
  const itemsB = [
    {role: 'user', scene: 'qq/group/90001', senderName: '群友甲', text: '群里好热闹', at: 2000, ref: {id: 'b1', revision: 1}},
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '这条私聊绝不能混进群聊', at: 2001, ref: {id: 'leak', revision: 1}},
  ];
  const rB = buildStagedMessages({...makeSyntheticTurn({packetId: 'pB1', scene: 'qq/group/90001', recentItems: itemsB}), tracker, options: opts});
  assert.equal(rB.meta.layer1Count, 1);
  assert.ok(!JSON.stringify(rB.messages).includes('这条私聊绝不能混进群聊'));

  // Back to private chat A with 7th message -> exceeds maxHistoryTurns (6) -> batch-rolls to retainOnRoll (3)!
  const itemsA2 = [
    ...itemsA,
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '私聊消息 7', at: 3000, ref: {id: 'a7', revision: 1}},
  ];
  const rA2 = buildStagedMessages({...makeSyntheticTurn({packetId: 'pA2', scene: 'qq/private/10001', recentItems: itemsA2}), tracker, options: opts});
  assert.equal(rA2.meta.rolled, true);
  assert.equal(rA2.meta.layer1Count, 3);
  assert.equal(rA2.meta.anchorKey, 'a5@1');

  // 8th message in private chat A -> anchor stays locked at a5@1 (append-only, no shift!)
  const itemsA3 = [
    ...itemsA2,
    {role: 'her', scene: 'qq/private/10001', text: '私聊消息 8', at: 3010, ref: {id: 'a8', revision: 1}},
  ];
  const rA3 = buildStagedMessages({...makeSyntheticTurn({packetId: 'pA3', scene: 'qq/private/10001', recentItems: itemsA3}), tracker, options: opts});
  assert.equal(rA3.meta.rolled, false);
  assert.equal(rA3.meta.layer1Count, 4);
  assert.equal(rA3.meta.anchorKey, 'a5@1');
  assert.deepEqual(rA3.messages.slice(1, 4), rA2.messages.slice(1, 4));
});

test('Anthropic cache_control is opt-in only and budget overflow falls back cleanly to legacy', () => {
  const hist = [
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '第一句', at: 1000, ref: {id: 'e1', revision: 1}},
    {role: 'user', scene: 'qq/private/10001', senderName: '阿钧', text: '连发第二句', at: 1005, ref: {id: 'e2', revision: 1}},
  ];
  const turn = makeSyntheticTurn({packetId: 'pkt_anth', recentItems: hist});

  const ds = buildStagedMessages({...turn, options: {provider: 'auto'}});
  assert.equal(typeof ds.messages[0].content, 'string');

  const anth = buildStagedMessages({...turn, options: {provider: 'anthropic'}});
  assert.equal(anth.applied, true);
  assert.equal(anth.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(anth.messages[1].content[0].cache_control.type, 'ephemeral');

  // Tiny budget forces safe fallback to legacy
  const tiny = makeSyntheticTurn({packetId: 'pkt_tiny', recentItems: hist, budgetBytes: 100});
  const fb = buildStagedMessages(tiny);
  assert.equal(fb.applied, false);
  assert.equal(fb.fallback, true);
  assert.equal(fb.wireLayout, 'legacy');
  assert.deepEqual(fb.messages, tiny.wire.messages);
});

test('unscoped events fall back, and history accepts only same-scene dialogue within its byte cap', () => {
  const recentItems=[
    {scene:'qq/private/10001',role:'tool',text:'tool detail'},
    {scene:'qq/private/10001',role:'user',text:'字'.repeat(600)},
    {scene:'qq/private/10001',role:'her',text:'short'},
    {scene:'qq/private/other',role:'user',text:'unrelated chat'},
  ];
  const unscoped=makeSyntheticTurn({packetId:'unscoped',scene:null,recentItems});
  assert.deepEqual(buildStagedMessages(unscoped).messages,unscoped.wire.messages);
  const scoped=buildStagedMessages({
    ...makeSyntheticTurn({packetId:'scoped',recentItems}),
    options:{maxHistoryBytes:1024},
  });
  assert.equal(scoped.applied,true);
  assert.deepEqual(scoped.messages.slice(1,-1),[{role:'assistant',content:'short'}]);
  assert.ok(scoped.meta.layer1Bytes<=1024);
});

test('resumed correction uses the same staged provider messages and never sends the primary again', async t => {
  const {store}=memory(t),subjectId='actor',scene='qq/private/test-person';
  const session=new ContinuitySession({store,subjectId,attention:true});
  const [prior,current,workspace]=put(store,'fixture',
    event('previous',{scene,body:'Earlier legitimate history [[image:https://example.invalid/old.png]]'}),
    event('current',{scene,body:'Tell me the next step'}),frame());
  admitSubjectEvent({store,subjectId,event:ref(prior),requestId:'admit:previous'});
  admitSubjectEvent({store,subjectId,event:ref(current),requestId:'admit:current'});
  const packet=await session.prepare({currentEvent:ref(current),workspace:ref(workspace),mind:true,unified:true,
    workbenchFocus:true,workbenchMaterials:true,localLookupPolicy:{maxReads:2,maxHits:4},intentProtocol:true,budgetBytes:131072});
  const ledgerPath=disk(t);
  const sent=[];
  const transport=async(_url,request)=>{
    const {messages}=JSON.parse(request.body);
    sent.push(messages);
    const final=sent.length===1?'broken JSON':JSON.stringify({
      packetId:JSON.parse(messages.at(-1).content).packetId,decision:{type:'reply',text:'Continue from history'},
    });
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:final}}],
      usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}}));
  };
  const open=wireLayout=>createModelDecision({ledgerPath,requestJournal:new RequestJournal(ledgerPath),
    getKey:()=> 'sk-synthetic-abcdefghijkl',networkCheck:async()=>({ok:true}),transport,
    profile:{intentProtocol:true,formatRecovery:true,wireLayout}});
  const primary=open('staged-v1');
  try{
    await assert.rejects(primary.decide(packet,{beforeCorrection:()=>{throw Error('interrupted before repair');}}),/interrupted before repair/);
    assert.equal(primary.ledger.find('turn:'+packet.packetId).wireTelemetry.wireLayout,'staged-v1');
    assert.equal(sent.length,1);
    assert.equal(typeof sent[0][1].content,'string','history must stay text at transport');
    assert.match(sent[0][1].content,/Earlier legitimate history/);
  }finally{primary.close();}
  const resumed=open('legacy');
  try{
    const corrected=JSON.parse(await resumed.decide(packet));
    assert.equal(corrected.decision.text,'Continue from history');
    assert.deepEqual(sent[1].slice(0,sent[0].length),sent[0]);
    assert.equal(sent.length,2);
    await resumed.decide(packet);
    assert.equal(sent.length,2);
  }finally{resumed.close();}
});

test('compare-wire-layout summarizeRows computes weighted cache hit rate and cost deltas cleanly', () => {
  const rows = [
    {
      id: 'turn:1', status: 'settled', actualMicros: 15000,
      source: {kind: 'event'},
      usage: {prompt: 8000, completion: 200, hit: 2400, miss: 5600, upperMicros: 15000},
      wireTelemetry: {wireLayout: 'legacy', durationMs: 2400, scene: 'qq/private/10001', sourceKind: 'event'},
      validation: {status: 'accepted'},
    },
    {
      id: 'turn:2', status: 'settled', actualMicros: 6000,
      source: {kind: 'event'},
      usage: {prompt: 8200, completion: 200, hit: 6560, miss: 1640, upperMicros: 6000},
      wireTelemetry: {wireLayout: 'staged-v1', durationMs: 1800, scene: 'qq/private/10001', sourceKind: 'event', fallback: false, rolled: false},
      validation: {status: 'accepted'},
    },
  ];
  const report = summarizeRows([...rows,{...rows[0],wireTelemetry:undefined},{...rows[0],wireTelemetry:{...rows[0].wireTelemetry,fallback:true}}]);
  assert.equal(report.byLayout.unclassified.count,1);
  assert.equal(report.byLayout.fallback.count,1);
  assert.equal(report.comparison.legacyCount,1);
  assert.equal(report.byLayout.legacy.weightedCacheHitRate, 0.3);
  assert.equal(report.byLayout['staged-v1'].weightedCacheHitRate, 0.8);
  assert.equal(report.comparison.cacheHitRateDelta, 0.5);
  assert.equal(report.comparison.avgCostPctChange, -60);
  assert.equal(report.comparison.medianDurationMsDelta, -600);
  const api=summarizeRows(rows.map(row=>({...row,wireTelemetry:{...row.wireTelemetry,scene:'local/gateway/session'}})));
  assert.equal(api.comparison,null);
  assert.equal(api.apiComparison.scenario,'api-chat');
  assert.equal(api.apiComparison.cacheHitRateDelta,0.5);
});
