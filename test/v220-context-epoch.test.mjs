import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createContextEpochEngine} from '../src/context-epoch.mjs';

test('context-epoch preserves byte-identical prefix for high KV-cache hits, compacts half at watermark, and preserves yesterday handoff on nightly rollover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-epoch-'));
  try {
    const engine = createContextEpochEngine({residentDir: dir, maxTokens: 400});
    engine.refreshFrozenPrefix({corePinboard: '主人喜欢喝乌龙茶，12月25日生日。'});

    const p1 = engine.assemblePrompt({systemPrompt: '你是鲸漾。', currentInput: '早安', tailCapsule: 'time=09:00 mood=happy'});
    assert.equal(p1.cacheHitEstimate, 0);
    engine.appendTurn({role: 'user', content: '早安', tailCapsule: 'time=09:00 mood=happy'});
    engine.appendTurn({role: 'assistant', content: '早安呀，今天怎么醒这么早？'});

    const p2 = engine.assemblePrompt({systemPrompt: '你是鲸漾。', currentInput: '我在写代码呢', tailCapsule: 'time=09:05 mood=focused'});
    // Static system + Turn 1 prefix remain 100% intact!
    assert.equal(p2.messages[0].content, p1.messages[0].content);
    assert.ok(p2.cacheHitEstimate > 0.4);
    engine.appendTurn({role: 'user', content: '我在写代码呢', tailCapsule: 'time=09:05 mood=focused'});
    engine.appendTurn({role: 'assistant', content: '加油，写完记得活动下脖子。'});

    // Mid-day half compaction folds oldest 50% while keeping recent turns intact
    const half = engine.compactHalf();
    assert.equal(half.compacted, true);
    assert.equal(half.droppedTurns, 2);
    assert.equal(half.keptTurns, 2);

    // Nightly Auto-Dream rollover clears day turns but preserves Yesterday Handoff!
    const roll = engine.rolloverNightly({nextCorePinboard: '主人喜欢喝乌龙茶，最近在赶代码。'});
    assert.equal(roll.rolledOver, true);
    assert.ok(roll.yesterdayHandoff.length > 0);
    assert.equal(engine.summary().turnsCount, 0);

    const nextMorning = engine.assemblePrompt({systemPrompt: '你是鲸漾。', currentInput: '早上好！'});
    assert.match(nextMorning.messages[0].content, /昨日交接/);
    assert.match(nextMorning.messages[0].content, /写代码/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
