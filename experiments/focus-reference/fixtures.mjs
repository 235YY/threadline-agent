// Synthetic declarations only. No online identity, memory or key.
export const I = (id, kind = 'process', epoch = '1') => ({kind, id, epoch});
export const V = (id, revision = 1, kind = 'process', epoch = '1') => ({...I(id, kind, epoch), revision});
export const A = (id, fields = {}) => ({...V(id), world: 'actual', lifecycle: 'open', label: id, ...fields});
export const R = (id, revision = 1, kind = 'note') => ({kind, id, revision});
export const M = (id, fields = {}) => ({ref: R(id), body: `尚未确认：${id}，不是完成回执。`,
  qualifiers: {world: 'actual', mode: 'historical', condition: '仅在原来的条件下'}, requires: [], ...fields});
export const E = (id, child, parent, fields = {}) => ({id, revision: 1, child: V(child), parent: V(parent), status: 'active', ...fields});
export const F = (id, path = [], kind = 'process', epoch = '1') => ({anchor: I(id, kind, epoch), path: path.map(x => typeof x === 'string' ? {id: x, revision: 1} : x)});
export const U = (id, consumer, record, fields = {}) => ({id, revision: 1, consumer: I(consumer), owners: [], context: null,
  record: typeof record === 'string' ? R(record) : record, purpose: 'active-task', status: 'open', presentation: 'full', cue: `继续时可查看${id}`, ...fields});
export const X = (fields = {}) => ({anchors: [A('a'), A('b'), A('c')], history: [], edges: [],
  materials: [M('m'), M('n')], continuity: [], ...fields});
export const op = (id, operation, fields = {}) => ({id, expectedRevision: 1, operation, presentation: null, ...fields});
export const patch = (fields = {}) => ({expectedRevision: 0, select: null, operations: [], ...fields});
export const largeBudget = {budgetBytes: 4 * 1024 * 1024};
