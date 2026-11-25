// Hot-Cold Separation Engine ('hot-cold-mind-v1'):
// Zero dependencies. Implements Step 3 + 4 distributed safeguards:
//   1. Atomic-Swap Compiled Mind Snapshot Store (O(1) hot-path read, never half-written)
//   2. Retrieval Deadline Budget (fast local search joins hot path; slow vector/association never blocks TTFT)
//   3. Single-Writer Async Slow-Brain Queue with micro-batching, expectedRevision CAS, & anti-hallucination guard
//   4. Lightweight traceId Causal Recorder for Glassbox observability

import {randomUUID} from 'node:crypto';

// 1. Atomic-Swap Compiled Mind Snapshot Store
export function createCompiledMindSnapshotStore({clock = Date.now} = {}) {
  const snapshots = new Map();

  function publish(residentId, data = {}) {
    const id = String(residentId || 'default');
    const prev = snapshots.get(id);
    const nextVersion = (prev?.version ?? 0) + 1;
    // Freeze a fresh immutable object so hot-path readers NEVER observe partial mutations.
    const frozen = Object.freeze({
      format: 'compiled-mind-snapshot-v1',
      residentId: id,
      version: nextVersion,
      compiledAt: clock(),
      identityBrief: String(data.identityBrief ?? '').slice(0, 400),
      moodBrief: String(data.moodBrief ?? '').slice(0, 160),
      topImpressions: Object.freeze((Array.isArray(data.topImpressions) ? data.topImpressions : []).slice(0, 8).map(s => String(s).slice(0, 140))),
      sourceEventIds: Object.freeze((Array.isArray(data.sourceEventIds) ? data.sourceEventIds : []).slice(0, 32)),
    });
    snapshots.set(id, frozen);
    return frozen;
  }

  function read(residentId) {
    return snapshots.get(String(residentId || 'default')) ?? null;
  }

  return {publish, read};
}

// 2. Deadline-Bounded Retrieval Helper (never lets slow semantic recall block hot-path TTFT)
export async function retrieveWithDeadline(fn, {timeoutMs = 80, onLateResult = null} = {}) {
  const started = performance.now();
  let settled = false;
  let timer = null;

  const work = Promise.resolve().then(() => fn()).then(result => {
    const elapsedMs = Math.round(performance.now() - started);
    if (settled) {
      onLateResult?.({result, elapsedMs});
      return null;
    }
    settled = true;
    if (timer) clearTimeout(timer);
    return {timedOut: false, result, elapsedMs};
  }).catch(error => {
    const elapsedMs = Math.round(performance.now() - started);
    if (settled) return null;
    settled = true;
    if (timer) clearTimeout(timer);
    return {timedOut: false, error, result: null, elapsedMs};
  });

  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({timedOut: true, result: null, elapsedMs: Math.round(performance.now() - started)});
    }, Math.max(5, timeoutMs));
  });

  return Promise.race([work, timeout]);
}

// 3. Single-Writer Async Slow-Brain Queue (micro-batching + expectedRevision CAS + anti-hallucination guard)
export function createAsyncSlowBrainQueue({
  batchWindowMs = 25,
  onCommitBatch = null,
  clock = Date.now,
} = {}) {
  const pending = [];
  const revisions = new Map(); // stateKey -> current integer revision
  let timer = null;
  let running = false;
  let processedBatches = 0;
  let rejectedStale = 0;
  let rejectedSelfReinforce = 0;

  function currentRevision(key) {
    return revisions.get(String(key)) ?? 0;
  }

  // Anti-hallucination guard: a memory/state write must cite at least one real event/user source_ref,
  // never solely AI-generated secondary inferences.
  function hasGroundedSourceRef(item) {
    if (!Array.isArray(item?.source_refs) || item.source_refs.length === 0) return false;
    return item.source_refs.some(r => r && typeof r.id === 'string' && r.id.length > 0 && r.kind !== 'ai_inference');
  }

  async function flush() {
    if (running || pending.length === 0) return {processed: 0, skipped: 0};
    running = true;
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = pending.splice(0, pending.length);
    const accepted = [];
    const rejected = [];

    try {
      for (const item of batch) {
        if (!hasGroundedSourceRef(item)) {
          rejectedSelfReinforce++;
          rejected.push({item, reason: 'UNGROUNDED_SELF_REINFORCEMENT'});
          continue;
        }
        const stateKey = String(item.stateKey || 'default');
        const curRev = currentRevision(stateKey);
        if (Number.isSafeInteger(item.expectedRevision) && item.expectedRevision !== curRev) {
          rejectedStale++;
          rejected.push({item, reason: 'STALE_REVISION_CONFLICT', expected: item.expectedRevision, actual: curRev});
          continue;
        }
        revisions.set(stateKey, curRev + 1);
        accepted.push({...item, committedRevision: curRev + 1, committedAt: clock()});
      }

      if (accepted.length > 0) {
        await onCommitBatch?.(accepted);
        processedBatches++;
      }
      return {processed: accepted.length, rejected, batchNumber: processedBatches};
    } finally {
      running = false;
      if (pending.length > 0 && !timer) {
        timer = setTimeout(() => { void flush(); }, batchWindowMs);
      }
    }
  }

  function enqueue(item) {
    pending.push({...item, enqueuedAt: clock()});
    if (!timer && !running) {
      timer = setTimeout(() => { void flush(); }, batchWindowMs);
    }
    return {queued: true, pendingCount: pending.length};
  }

  function stats() {
    return {
      pending: pending.length,
      processedBatches,
      rejectedStale,
      rejectedSelfReinforce,
    };
  }

  return {enqueue, flush, currentRevision, stats};
}

// 4. Lightweight traceId Causal Recorder for Glassbox debugging
export function createTraceRecorder({maxTraces = 200, clock = Date.now} = {}) {
  const ring = [];

  function record(entry = {}) {
    const trace = {
      traceId: entry.traceId || `tr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      at: clock(),
      sceneId: entry.sceneId ?? 'default',
      protocolId: entry.protocolId ?? 'companion-chat',
      channel: entry.channel ?? 'mind-native',
      localPrepMs: Number.isFinite(entry.localPrepMs) ? Math.round(entry.localPrepMs) : null,
      firstContentMs: Number.isFinite(entry.firstContentMs) ? Math.round(entry.firstContentMs) : null,
      totalMs: Number.isFinite(entry.totalMs) ? Math.round(entry.totalMs) : null,
      promptTokens: Number.isSafeInteger(entry.promptTokens) ? entry.promptTokens : null,
      cacheHitTokens: Number.isSafeInteger(entry.cacheHitTokens) ? entry.cacheHitTokens : null,
      costMicros: Number.isSafeInteger(entry.costMicros) ? entry.costMicros : null,
      matchedMemoryIds: Array.isArray(entry.matchedMemoryIds) ? entry.matchedMemoryIds.slice(0, 12) : [],
      filteredNoise: Boolean(entry.filteredNoise),
      interrupted: Boolean(entry.interrupted),
      protocolOk: entry.protocolOk !== false,
    };
    ring.push(trace);
    while (ring.length > maxTraces) ring.shift();
    return trace;
  }

  function recent(limit = 30) {
    return ring.slice(-Math.max(1, Math.min(maxTraces, limit))).reverse();
  }

  return {record, recent, all: () => [...ring]};
}
