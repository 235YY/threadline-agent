import test from 'node:test';
import assert from 'node:assert/strict';
import {memory, put, ref} from './helpers.mjs';
import {ContinuitySession} from '../src/continuity-session.mjs';
import {graphFixture, prepare} from '../experiments/unified-graph/fixture.mjs';

test('no affect projection: continuity and decision preparation still work', t => {
  const {store} = memory(t);
  const s = graphFixture(store);
  const packet = prepare(s);
  assert.equal(packet.payload.continuity.motivation, undefined);
  assert.equal(s.session.sourceBlocked('not-an-event'), false);
});

test('session source blocking is optional and defaults to false', t => {
  const {store} = memory(t);
  put(store, 'subject', {op: 'initialize_subject', id: 'plain', maxForeground: 8});
  const session = new ContinuitySession({store, subjectId: 'plain'});
  assert.equal(session.sourceBlocked('e'), false);
  assert.equal(typeof session.prepare, 'function');
  assert.equal(typeof session.commit, 'function');
});
