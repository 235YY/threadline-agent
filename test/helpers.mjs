import {mkdtempSync, unlinkSync, rmdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuityStore} from '../src/store.mjs';

export const ref = record => ({id: record.id, revision: record.revision});
export const event = (id, fields = {}) => ({op: 'append_event', id, body: `事件 ${id}`, scene: 'qq:brother',
  actor: 'brother', origin: 'reported', source: {system: 'fixture', key: id}, occurredAt: 1000, ...fields});
export const note = (id, evidence = [], fields = {}) => ({op: 'write_note', id, expectedRevision: 0,
  body: `认识 ${id}`, kind: 'interpretation', change: evidence.length ? 'new_evidence' : 'self_report', evidence, ...fields});
export const frame = (fields = {}) => ({op: 'set_workspace', id: 'qq', expectedRevision: 0, scene: 'qq:brother',
  focus: {id: 'present', label: '眼前对话'}, ...fields});
export const put = (store, requestId, ...commands) => store.execute({requestId, commands});
export function memory(t) {
  let now = 2000;
  const store = new ContinuityStore(':memory:', {clock: () => now});
  t.after(() => store.close());
  return {store, setTime: value => {now = value;}};
}
export function disk(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jingyang-core-test-'));
  const path = join(dir, 'core.sqlite');
  t.after(() => {
    // Delete only the explicitly created DB files, never a recursive or computed parent tree.
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(dir);
  });
  return path;
}
export const code = expected => error => error.code === expected;
