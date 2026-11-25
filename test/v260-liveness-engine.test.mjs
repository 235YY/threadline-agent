import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeStructuredWork,
  splitNaturalBubbles,
  createDebounceMerger,
  emotionAuraProfile,
  evaluateBaselineNudge,
  createInnerThoughtsPool,
} from '../src/liveness-engine.mjs';

test('splitNaturalBubbles splits casual chat into paced bubbles, strips stiff cliches, and never splits structured work', () => {
  // Structured work output stays intact
  const codeReply = '这里有个修复方案：\n```js\nconst x = 1;\n```\n1. 先测试\n2. 再发布';
  assert.equal(looksLikeStructuredWork(codeReply), true);
  const workBubbles = splitNaturalBubbles(codeReply);
  assert.equal(workBubbles.length, 1);
  assert.equal(workBubbles[0].structured, true);

  // Casual chat splits naturally and drops stiff trailing AI filler
  const casual = '哈哈我也觉得这关好难打！你刚刚那个走位其实已经很极限了，下次换个思路试试看呀。希望能帮到你！';
  const bubbles = splitNaturalBubbles(casual);
  assert.ok(bubbles.length >= 2 && bubbles.length <= 3);
  assert.equal(bubbles[0].delayMs, 0);
  assert.ok(bubbles[1].delayMs >= 420);
  assert.ok(!bubbles.map(b => b.text).join('').includes('希望能帮到你'));
});

test('createDebounceMerger coalesces rapid consecutive user bursts without interrupting', async () => {
  const flushed = [];
  const merger = createDebounceMerger({windowMs: 40, maxWaitMs: 200, onFlush: p => flushed.push(p)});
  merger.push('qq:10001', '我刚下课');
  merger.push('qq:10001', '累死了');
  merger.push('qq:10001', '今晚吃啥好');
  await new Promise(r => setTimeout(r, 90));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].count, 3);
  assert.equal(flushed[0].text, '我刚下课\n累死了\n今晚吃啥好');
  merger.clearAll();
});

test('emotionAuraProfile maps Limbic affect to mascot visual aura cues', () => {
  const happy = emotionAuraProfile({affect: {emotions: [{name: 'joy', intensity: 0.8}]}});
  assert.equal(happy.tag, 'happy');
  assert.ok(happy.caption.includes('开心'));

  const sleepy = emotionAuraProfile({affect: {mood: {valence: 0, arousal: -0.5}}});
  assert.equal(sleepy.tag, 'sleepy');
});

test('evaluateBaselineNudge triggers only on baseline deviation and respects Curtain Mode and cooldown', () => {
  const lateNight = new Date('2026-11-24T02:15:00').getTime();
  const status = {
    curtain: false,
    effectiveLevel: 'L1',
    activeSignals: [{kind: 'activity', app: 'Code.exe', summary: '写代码 45 分钟'}],
  };
  const r1 = evaluateBaselineNudge({sensoryStatus: status, now: lateNight, lastNudgeAt: 0});
  assert.equal(r1.shouldNudge, true);
  assert.equal(r1.kind, 'late-night-care');

  // Cooldown blocks immediate repeat
  const r2 = evaluateBaselineNudge({sensoryStatus: status, now: lateNight + 60_000, lastNudgeAt: lateNight});
  assert.equal(r2.shouldNudge, false);
  assert.equal(r2.reason, 'COOLDOWN_ACTIVE');

  // Curtain Mode blocks immediately
  const r3 = evaluateBaselineNudge({sensoryStatus: {...status, curtain: true}, now: lateNight});
  assert.equal(r3.shouldNudge, false);
  assert.equal(r3.reason, 'SENSORY_OFF_OR_CURTAIN');

  // Daytime normal work within baseline stays quiet
  const daytime = new Date('2026-11-24T14:30:00').getTime();
  const r4 = evaluateBaselineNudge({sensoryStatus: status, now: daytime});
  assert.equal(r4.shouldNudge, false);
  assert.equal(r4.reason, 'WITHIN_NORMAL_BASELINE');

  // Long focus > 120 min triggers gentle break nudge
  const longFocus = evaluateBaselineNudge({
    sensoryStatus: {curtain: false, effectiveLevel: 'L1', activeSignals: [{kind: 'activity', app: 'Code.exe', summary: '连续写代码 135 分钟'}]},
    now: daytime,
  });
  assert.equal(longFocus.shouldNudge, true);
  assert.equal(longFocus.kind, 'long-focus-break');
});

test('createInnerThoughtsPool boosts topic-relevant thoughts, decays over time, and expresses once', () => {
  let fakeNow = 1_000_000;
  const pool = createInnerThoughtsPool({clock: () => fakeNow});
  pool.add({text: '想问问她昨天实验四最后调通了没有', topic: '实验四', motivation: 0.6});

  // Below threshold on unrelated topic
  assert.equal(pool.pickReady({contextText: '今天午饭吃什么'}), null);

  // Relevant topic boosts motivation over threshold and expresses once
  const picked = pool.pickReady({contextText: '刚才又看了一眼实验四的数据'});
  assert.ok(picked);
  assert.ok(picked.text.includes('实验四'));

  // Never repeats after being expressed
  assert.equal(pool.pickReady({contextText: '实验四'}), null);
});
