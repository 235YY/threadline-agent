import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {keepAttention} from '../src/attention.mjs';

const reflection = (packet, option) => JSON.stringify({packetId: packet.packetId, options: [option], selected: option.id,
  summary: 'idle autonomy fixture', used: [], continuity: {changes: [], residency: {add: [], remove: []}, attention: keepAttention()}});
const taskOutput = packet => JSON.stringify({packetId: packet.packetId, options: [{id: 'f', kind: 'act', payload: {tool: 'task_finish', args: {result: '研究完成'}}}],
  selected: 'f', summary: 'task done', used: [], continuity: {changes: [], residency: {add: [], remove: []}, expressionChoice: null, observationDisposition: 'handled', attention: keepAttention()}});

test('idle reflection can form an Intent, start a task, and receive its result', async t => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const decide = packet => {
    calls++;
    if (packet.stage === 'reflection') {
      if (calls === 1) return reflection(packet, {id: 'i', kind: 'intent', payload: {goal: '研究受控主题', rationale: '空闲时想继续', nextAction: '启动只读任务'}});
      const intentId = packet.payload.continuity.intents?.[0]?.id;
      return reflection(packet, {id: 'a', kind: 'act', payload: {tool: 'start_agent_task', args: {goal: '研究受控主题', intentId}}});
    }
    return taskOutput(packet);
  };
  const service = await startBrainService({port: 0, allowedActionTools:['start_agent_task'], storePath: ':memory:', heartbeatMs: 0, global: true, subjectTask: true,
    idleIntervalMs: 100, rhythm: {beatMs: 1, quietBeatMs: 1, quietFromHour: 0, quietToHour: 0}, clock: () => now, decide, agentTools: {}});
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); });
  now += 201;
  await service.idleReflect();
  now += 2;
  const first = await service.idleReflect();
  assert.equal(first.action, 'reflected');
  const intent = [...service.store.all('intent')][0];
  assert.ok(intent);
  now += 101;
  const second = await service.idleReflect();
  assert.equal(second.action, 'reflected');
  assert.equal(service.listAgent().length, 1);
  assert.equal(service.listAgent()[0].intentRef.id, intent.id);
  await service.agentTick();
  assert.equal(service.listAgent()[0].status, 'done');
  const result = [...service.store.all('event')].find(e => e.id.startsWith('agent-result:'));
  assert.ok(result);
  assert.ok(service.store.subjectObservation('jingyang', result.id));
});
