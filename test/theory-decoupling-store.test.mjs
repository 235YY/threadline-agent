import test from 'node:test';
import assert from 'node:assert/strict';
import {memory, put, code, ref} from './helpers.mjs';
import {graphFixture, prepare, proposal} from '../experiments/unified-graph/fixture.mjs';

function seed(store) {
  put(store, 'subject', {op: 'initialize_subject', id: 'theory-test', maxForeground: 8});
  const [event] = put(store, 'event', {op: 'append_event', id: 'theory-event', body: 'fixture', scene: 'local',
    actor: 'brother', origin: 'reported', source: {system: 'fixture', key: 'theory-event'}, occurredAt: 1000});
  put(store, 'admit', {op: 'admit_subject_event', subjectId: 'theory-test', event: ref(event)});
  return event;
}

test('extension_record is theory-neutral and CAS-protected', t => {
  const {store} = memory(t);
  seed(store);
  const command = {
    op: 'put_extension_record',
    id: 'extension:theory-test:mock:motivation',
    owner: 'theory-test',
    theory: 'mock',
    stateType: 'motivation',
    schemaVersion: 'mock-v1',
    expectedRevision: 0,
    value: {energy: 0.5}
  };
  put(store, 'ext', command);
  assert.deepEqual(store.read(command.id).value, {energy: 0.5});
  assert.equal(store.read(command.id).type, 'extension_record');
  assert.throws(() => put(store, 'stale', {...command, expectedRevision: 0, value: {energy: 0.9}}), code('EXTENSION_CONFLICT'));
  assert.deepEqual(store.read(command.id).value, {energy: 0.5});
});

test('extension write failure rolls back the whole transaction', t => {
  const {store} = memory(t);
  seed(store);
  assert.throws(() => store.execute({
    requestId: 'rollback',
    commands: [
      {op: 'put_extension_record', id: 'extension:theory-test:mock:rollback', owner: 'theory-test', theory: 'mock',
        stateType: 'rollback', schemaVersion: 'mock-v1', expectedRevision: 0, value: {ok: true}},
      {op: 'append_event', id: 'bad-event', body: 'x', scene: 'local', actor: 'brother', origin: 'not-valid'}
    ]
  }), /invalid origin/);
  assert.equal(store.read('extension:theory-test:mock:rollback'), null);
});

test('quarantine_source is idempotent and closes the source inbox row', t => {
  const {store} = memory(t);
  const event = seed(store);
  const subjectRef = ref(store.read('theory-test'));
  const first = store.execute({requestId: 'q1', commands: [{op: 'quarantine_source', subject: subjectRef,
    event: ref(event), reason: 'legacy-closed-incomplete'}]}).at(-1);
  assert.equal(first.type, 'decision_attempt');
  assert.equal(first.status, 'quarantined');
  const inbox = store.subjectObservation('theory-test', 'theory-event');
  assert.equal(inbox.status, 'handled');
  assert.equal(inbox.decisionId, first.id);
  const second = store.execute({requestId: 'q2', commands: [{op: 'quarantine_source', subject: subjectRef,
    event: ref(event), reason: 'legacy-closed-incomplete'}]}).at(-1);
  assert.equal(second.id, first.id);
  assert.equal(store.subjectInbox({subjectId: 'theory-test'}).total, 0);
});

test('advance_subject and extension writes share one transaction', t => {
  const {store} = memory(t);
  const s = graphFixture(store);
  const packet = prepare(s);
  const before = store.read('fixture-person').revision;
  const ext = id => ({op: 'put_extension_record', id: 'extension:fixture-person:mock:atomic', owner: 'fixture-person',
    theory: 'mock', stateType: 'motivation', schemaVersion: 'mock-v1', expectedRevision: 0, value: {id}});
  assert.throws(() => s.session.commit({packet, output: proposal(packet), requestId: 'atomic-fail', decisionId: 'atomic-fail',
    extensionWrites: [ext('first'), ext('second')]}), code('EXTENSION_CONFLICT'));
  assert.equal(store.read('fixture-person').revision, before);
  assert.equal(store.read('extension:fixture-person:mock:atomic'), null);
});
