import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrainService} from '../tools/brain-service/server.mjs';

test('background thought is not started during quiet hours', async () => {
  // 23:30 Asia/Shanghai, even when the host OS runs in another timezone.
  const now = Date.parse('2026-11-22T15:30:00Z');
  let calls = 0;
  const service = createBrainService({
    storePath: ':memory:',
    clock: () => now,
    global: true,
    autonomy: true,
    heartbeatMs: 60_000,
    idleIntervalMs: 1,
    rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 23, quietToHour: 7},
    decide: () => { calls++; return {format: 'fixture'}; }
  });
  try {
    const reflection = await service.idleReflect();
    assert.equal(reflection.skipped, true);
    assert.equal(reflection.reason, 'quiet-hours');
    const autonomy = await service.autonomyTick({now});
    assert.equal(autonomy.skipped, true);
    assert.equal(autonomy.reason, 'quiet-hours');
    assert.equal(calls, 0);
  } finally {
    service.close();
  }
});
