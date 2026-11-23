import test from 'node:test';
import assert from 'node:assert/strict';
import {memory, put, ref, event} from './helpers.mjs';

test('fail_subject_event creates a durable deferred attempt and clears pending inbox', t => {
  const {store}=memory(t);
  put(store,'subject',{op:'initialize_subject',id:'subject',maxForeground:8});
  const subject=store.read('subject');
  const [source]=put(store,'source',event('source-failure'));
  put(store,'admit',{op:'admit_subject_event',subjectId:'subject',event:ref(source)});

  const command={op:'fail_subject_event',subject:ref(subject),event:ref(source),reason:'UNCERTAIN_REQUEST'};
  const [first]=put(store,'failure',command);
  const id='input-failure:subject:source-failure';
  assert.equal(first.id,id);
  assert.equal(first.status,'deferred');

  const inbox=store.subjectInbox({subjectId:'subject',pendingOnly:false}).items.find(item=>item.eventId===source.id);
  assert.equal(inbox.status,'deferred');
  assert.equal(inbox.decisionId,id);
  assert.equal(store.subjectInbox({subjectId:'subject',pendingOnly:true}).total,0);

  const attempt=store.read(id);
  assert.equal(attempt.type,'decision_attempt');
  assert.equal(attempt.status,'deferred');
  assert.equal(attempt.input.currentEvent.id,source.id);
  assert.equal(attempt.failure.reason,'UNCERTAIN_REQUEST');

  const revision=attempt.revision;
  put(store,'failure-retry',command);
  assert.equal(store.read(id).revision,revision,'retry is idempotent');
  assert.equal(store.subjectInbox({subjectId:'subject',pendingOnly:true}).total,0);
});

test('late failure cannot overwrite a handled source or its original decision',t=>{
 const {store}=memory(t);put(store,'subject',{op:'initialize_subject',id:'subject',maxForeground:8});const [source]=put(store,'source',event('late-failure'));
 put(store,'admit',{op:'admit_subject_event',subjectId:'subject',event:ref(source)});
 put(store,'handled',{op:'quarantine_source',subject:ref(store.read('subject')),event:ref(source),reason:'original-final-outcome'});
 const before=store.subjectObservation('subject',source.id);
 assert.throws(()=>put(store,'late',{op:'fail_subject_event',subject:ref(store.read('subject')),event:ref(source),reason:'late-error'}),e=>e.code==='FAILURE_ALREADY_FINAL');
 assert.deepEqual(store.subjectObservation('subject',source.id),before);
});
