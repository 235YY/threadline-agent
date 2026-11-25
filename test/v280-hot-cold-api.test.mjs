import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderSSEStream} from '../src/upstream-sse.mjs';
import {validateExternalWorkRequest, buildWorkChannelRequest, sanitizeWorkChannelResponse} from '../src/work-channel.mjs';
import {createCompiledMindSnapshotStore, retrieveWithDeadline, createAsyncSlowBrainQueue, createTraceRecorder} from '../experiments/hot-cold-mind.mjs';
import {summarizeChannelMetrics} from '../tools/ops/bench-api-channels.mjs';
import {buildStudyRequest,reuseSuccessfulNetworkProbe} from '../src/model-client.mjs';

function makeSSEStream(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
}

test('Step 1: parseProviderSSEStream measures firstContentMs, stitches tool_calls, quarantines CoT, and fails closed on truncated stream', async () => {
  const stream = makeSSEStream([
    {id: 'chatcmpl-1', model: 'deepseek-flash', created: 1700000000, choices: [{delta: {reasoning_content: 'secret chain of thought'}}]},
    {choices: [{delta: {content: '你好'}}]},
    {choices: [{delta: {content: '呀！', tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'read_file', arguments: '{"path":'}}]}}]},
    {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"a.txt"}'}}]}, finish_reason: 'tool_calls'}]},
    {choices: [], usage: {prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200}},
    '[DONE]',
  ]);

  const parsed = await parseProviderSSEStream(stream);
  assert.equal(parsed.settled, true);
  assert.equal(parsed.content, '你好呀！');
  assert.ok(!parsed.content.includes('secret chain of thought'));
  assert.ok(parsed.reasoningQuarantinedChars > 0);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].id, 'call_1');
  assert.equal(parsed.toolCalls[0].function.name, 'read_file');
  assert.equal(parsed.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.usage.prompt_cache_hit_tokens, 800);
  assert.ok(Number.isFinite(parsed.timing.firstContentMs));

  // Truncated stream without [DONE] or usage -> settled MUST be false (UNKNOWN)
  const broken = makeSSEStream([{choices: [{delta: {content: '半句话'}}]}]);
  const resBroken = await parseProviderSSEStream(broken);
  assert.equal(resBroken.settled, false);
  assert.equal(resBroken.reason, 'STREAM_TRUNCATED_NO_DONE');

  // Opt-in stream flag in buildStudyRequest defaults to false, supports true with include_usage
  assert.equal(buildStudyRequest([{role: 'user', content: 'hi'}]).stream, false);
  const reqStream = buildStudyRequest([{role: 'user', content: 'hi'}], {stream: true});
  assert.equal(reqStream.stream, true);
  assert.equal(reqStream.stream_options.include_usage, true);
});

test('provider preflight reuses only positive results for a bounded time',async()=>{
 let now=0,calls=0;
 const probe=reuseSuccessfulNetworkProbe(async()=>({ok:++calls!==3}),{clock:()=>now,ttlMs:30_000});
 assert.equal((await probe()).reused,false);
 assert.equal((await probe()).reused,true);
 now=30_000;
 assert.equal((await probe()).reused,false);
 probe.invalidate();
 assert.equal((await probe()).ok,false);
 assert.equal((await probe()).ok,true);
 assert.equal(calls,4);
});

test('provider SSE requires both accounting and a completed choice',async()=>{
 const usage={prompt_tokens:1,completion_tokens:2};
 const missingFinish=await parseProviderSSEStream(makeSSEStream([{choices:[{delta:{content:'x'}}]},{choices:[],usage},'[DONE]']));
 assert.equal(missingFinish.settled,false);
 const ascii='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":1}}\r\n\r\ndata: [DONE]\r\n\r\n';
 assert.equal((await parseProviderSSEStream(new Response(ascii).body)).content,'ok');
});

test('Step 2: Fidelity Work Channel preserves tool_call_id/tools/finish_reason, injects authorized snapshot, and never grants host tools', () => {
  assert.equal(validateExternalWorkRequest({messages: [{role: 'tool', content: 'ok'}]}).ok, false);

  const built = buildWorkChannelRequest({
    body: {
      model: 'jingyang:work',
      stream: true,
      tools: [{type: 'function', function: {name: 'edit_code'}}],
      tool_choice: 'auto',
      response_format: {type: 'json_object'},
      messages: [
        {role: 'system', content: 'You are a coding assistant.'},
        {role: 'user', content: 'Fix bug in app.js'},
        {role: 'assistant', content: null, tool_calls: [{id: 'call_9', type: 'function', function: {name: 'edit_code', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'call_9', content: 'patched'},
      ],
    },
    mindSnapshot: {identityBrief: '鲸漾（专注态）'},
    authorizedMemoryLines: ['用户偏好零第三方依赖'],
  });

  assert.equal(built.hostToolAuthorityGranted, false);
  assert.equal(built.preservedToolCount, 1);
  assert.equal(built.upstream.messages[3].tool_call_id, 'call_9');
  assert.ok(built.upstream.messages[0].content.includes('用户偏好零第三方依赖'));
  assert.equal(built.upstream.stream_options.include_usage, true);

  const resp = sanitizeWorkChannelResponse({
    completionId: 'chatcmpl-work-1',
    model: 'jingyang:work',
    content: '',
    toolCalls: [{id: 'call_9', type: 'function', function: {name: 'edit_code', arguments: '{}'}}],
    finishReason: 'tool_calls',
  });
  assert.equal(resp.choices[0].finish_reason, 'tool_calls');
  assert.equal(resp.choices[0].message.tool_calls[0].id, 'call_9');
});

test('Step 3: Hot-Cold Snapshot atomic swap, 80ms retrieval deadline, Single-Writer CAS, and anti-hallucination guard', async () => {
  const store = createCompiledMindSnapshotStore();
  const s1 = store.publish('jingyang', {identityBrief: '鲸漾', moodBrief: '开心', topImpressions: ['喜欢美式']});
  assert.equal(s1.version, 1);
  assert.ok(Object.isFrozen(s1));
  const s2 = store.publish('jingyang', {identityBrief: '鲸漾', moodBrief: '专注', topImpressions: ['正在改代码']});
  assert.equal(s2.version, 2);
  assert.equal(store.read('jingyang').moodBrief, '专注');

  // Retrieval deadline: fast returns synchronously, slow times out cleanly and fires onLateResult
  const fast = await retrieveWithDeadline(async () => ['mem1'], {timeoutMs: 80});
  assert.equal(fast.timedOut, false);
  assert.deepEqual(fast.result, ['mem1']);

  let lateArrived = false;
  const slow = await retrieveWithDeadline(
    () => new Promise(r => setTimeout(() => r(['late_mem']), 70)),
    {timeoutMs: 15, onLateResult: () => { lateArrived = true; }},
  );
  assert.equal(slow.timedOut, true);
  await new Promise(r => setTimeout(r, 90));
  assert.equal(lateArrived, true);

  // Single-writer async queue: rejects AI-only self-reinforcement AND stale expectedRevision
  const committed = [];
  const queue = createAsyncSlowBrainQueue({batchWindowMs: 5, onCommitBatch: async b => committed.push(...b)});
  queue.enqueue({stateKey: 'pref:coffee', text: 'AI 自己猜的', source_refs: [{id: 'inf:1', kind: 'ai_inference'}]});
  queue.enqueue({stateKey: 'pref:coffee', text: '主人亲口说改喝美式', expectedRevision: 0, source_refs: [{id: 'ev:10', kind: 'event'}]});
  queue.enqueue({stateKey: 'pref:coffee', text: '迟到的旧反思', expectedRevision: 0, source_refs: [{id: 'ev:9', kind: 'event'}]});
  const res = await queue.flush();
  assert.equal(res.processed, 1);
  assert.equal(committed.length, 1);
  assert.equal(queue.stats().rejectedSelfReinforce, 1);
  assert.equal(queue.stats().rejectedStale, 1);
});

test('Step 4: TraceRecorder and summarizeChannelMetrics report per-protocol p50/p95 TTFT, cache hit rate, and cost', () => {
  const rec = createTraceRecorder();
  rec.record({protocolId: 'voice-live', firstContentMs: 420, totalMs: 1100, promptTokens: 2000, cacheHitTokens: 1600, costMicros: 3000});
  rec.record({protocolId: 'voice-live', firstContentMs: 680, totalMs: 1400, promptTokens: 2000, cacheHitTokens: 1800, costMicros: 2600});
  rec.record({protocolId: 'work-agent', firstContentMs: 1200, totalMs: 3200, promptTokens: 20000, cacheHitTokens: 17000, costMicros: 14000});

  const summary = summarizeChannelMetrics(rec.all());
  assert.equal(summary.byProtocol['voice-live'].count, 2);
  assert.equal(summary.byProtocol['voice-live'].weightedCacheHitRate, 0.85);
  assert.equal(summary.byProtocol['voice-live'].firstContentP95Ms, 680);
  assert.equal(summary.byProtocol['work-agent'].weightedCacheHitRate, 0.85);
  assert.equal(summary.byProtocol['work-agent'].protocolCorrectnessRate, 1);
});
