import test from 'node:test';
import assert from 'node:assert/strict';
import {memory, put} from './helpers.mjs';
import {AffectSession} from '../tools/affect-integrated/session.mjs';
import {proposal} from '../experiments/unified-graph/fixture.mjs';

test('AffectSession still commits a captured decision after core decoupling', async t => {
  const T=1794400000000;
  const {store} = memory(t);
  const event = id => {
    store.execute({requestId: id, commands: [{op: 'append_event', id, body: '合成消息', origin: 'reported', actor: 'fixture', scene: 'synthetic', occurredAt: T, source: {system: 'fixture', key: id}}]});
    return {id, revision: 1};
  };
  store.execute({requestId: 'workspace', commands: [{op: 'set_workspace', id: 'w', expectedRevision: 0, scene: 'synthetic', focus: {id: 'now', label: '合成'}}]});
  const session = new AffectSession({store, subjectId: 'affect-commit', clock: () => T});
  const args = currentEvent => ({currentEvent, workspace: {id: 'w', revision: 1}, identity: '合成主体', now: T, budgetBytes: 90000, mind: true, unified: true,
    localLookupPolicy: {maxReads: 2, maxHits: 4}, allowedActionTools: []});
  const packet = await session.prepare(args(event('affect-commit-event')));
  assert.ok(packet.payload.continuity.motivation);
  const output = proposal(packet);
  const raw = JSON.stringify(output);
  await session.invoke(packet, () => raw);
  const decision = await session.commit({packet, output: raw, requestId: 'affect-commit-request', decisionId: 'affect-commit-decision'});
  assert.equal(decision.type, 'decision');
  assert.equal(store.read('affect-commit').motivationState.revision, 2);
  assert.equal([...store.all('affect_turn')][0].status, 'committed');
});
