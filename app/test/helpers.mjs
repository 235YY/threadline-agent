let seq = 0;

export const ref = record => ({ id: record.id, revision: record.revision });

export function frame({
  id = 'qq',
  expectedRevision = 0,
  scene = 'qq/private/owner',
  focus = { id: 'focus:qq', label: 'QQ' },
  workingRefs = [],
  continuityRefs = [],
  actionRefs = [],
  resume = '',
} = {}) {
  return { op: 'set_workspace', id, expectedRevision, scene, focus, workingRefs, continuityRefs, actionRefs, resume };
}

export function event(id, overrides = {}) {
  return {
    op: 'append_event',
    id,
    body: 'event',
    scene: 'qq/group/9',
    origin: 'reported',
    source: { system: 'test', key: id },
    actor: 'owner',
    occurredAt: Date.now(),
    ...overrides,
  };
}

export function note(id, evidence = [], overrides = {}) {
  return {
    op: 'write_note',
    id,
    expectedRevision: 0,
    body: 'note',
    kind: 'fact_claim',
    change: evidence.length > 0 ? 'new_evidence' : 'self_report',
    evidence,
    ...overrides,
  };
}

export function put(store, label, command) {
  return store.execute({ requestId: `helper:${label}:${++seq}`, commands: [command] });
}
