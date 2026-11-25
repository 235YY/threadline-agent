// Upstream OpenAI/DeepSeek SSE parser ('upstream-sse-v1'):
// Zero dependencies. Parses streaming chat completion frames while strictly enforcing:
//   1. Upstream first-content arrival timing (firstContentMs) vs total completion latency.
//   2. Exact tool_calls delta reassembly by index (id, type, name, arguments).
//   3. Strict quarantine of reasoning_content (internal CoT NEVER leaks into public output).
//   4. Fail-closed settlement: stream truncation or missing final usage -> settled=false (UNKNOWN).

export async function parseProviderSSEStream(readableStream, {
  maxBytes = 2 * 1024 * 1024,
  startedAt = performance.now(),
  onContentDelta = null,
  onToolCallDelta = null,
} = {}) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let buffer = '';
  let totalBytes = 0;

  let content = '';
  let reasoningChars = 0;
  let firstContentMs = null;
  let firstReasoningMs = null;
  let finishReason = null;
  let reportedModel = null;
  let providerResponseId = null;
  let providerCreated = null;
  let usage = null;
  let sawDone = false;

  const toolCallsByIndex = new Map();

  function mergeToolDelta(tc) {
    const idx = Number.isInteger(tc?.index) ? tc.index : toolCallsByIndex.size;
    let entry = toolCallsByIndex.get(idx);
    if (!entry) {
      entry = {
        index: idx,
        id: '',
        type: tc?.type || 'function',
        function: {name: '', arguments: ''},
      };
      toolCallsByIndex.set(idx, entry);
    }
    if (typeof tc?.id === 'string' && tc.id) entry.id = tc.id;
    if (typeof tc?.type === 'string' && tc.type) entry.type = tc.type;
    if (typeof tc?.function?.name === 'string') entry.function.name += tc.function.name;
    if (typeof tc?.function?.arguments === 'string') entry.function.arguments += tc.function.arguments;
    onToolCallDelta?.(tc, entry);
  }

  function processEventBlock(block) {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    if(sawDone)throw Object.assign(Error('Unexpected frame after completion'),{code:'PROVIDER_SSE_TRAILING'});
    const data = dataLines.join('\n').trim();
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw Object.assign(new Error('Provider SSE frame was not valid JSON'), {code: 'PROVIDER_SSE_JSON'});
    }

    if(!parsed||typeof parsed!=='object'||parsed.error)throw Object.assign(Error('Provider stream error frame'),{code:'PROVIDER_SSE_ERROR'});
    if(typeof parsed.id==='string'){
      if(providerResponseId!==null&&parsed.id!==providerResponseId)throw Object.assign(Error('Provider changed response identity'),{code:'PROVIDER_SSE_ID'});
      providerResponseId=parsed.id;
    }
    if (typeof parsed.model === 'string') reportedModel = parsed.model;
    if (Number.isSafeInteger(parsed.created)) providerCreated = parsed.created;
    if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;

    if(!Array.isArray(parsed.choices)||parsed.choices.length>1||parsed.choices[0]?.index>0)throw Object.assign(Error('Expected one provider choice'),{code:'PROVIDER_SSE_CHOICE'});
    const choice = parsed.choices[0];
    if (!choice) return;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta ?? {};
    // Quarantine internal CoT: measure timing/length only, NEVER append to public content.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (firstReasoningMs === null) firstReasoningMs = Math.round(performance.now() - startedAt);
      reasoningChars += delta.reasoning_content.length;
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (firstContentMs === null) firstContentMs = Math.round(performance.now() - startedAt);
      content += delta.content;
      onContentDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) mergeToolDelta(tc);
    }
  }

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      totalBytes += value.byteLength ?? value.length ?? 0;
      if (totalBytes > maxBytes) {
        throw Object.assign(new Error('Provider SSE stream exceeded maxBytes'), {code: 'RESPONSE_LIMIT'});
      }
      buffer += decoder.decode(value, {stream: true});
      let sep;
      while((sep=/\r\n\r\n|\n\n|\r\r/.exec(buffer))!==null){
        const block=buffer.slice(0,sep.index);
        buffer=buffer.slice(sep.index+sep[0].length);
        if (block.trim()) processEventBlock(block);
      }
      if(sawDone)break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) processEventBlock(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const toolCalls = [...toolCallsByIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map(({index: _i, ...rest}) => rest);

  const latencyMs = Math.round(performance.now() - startedAt);
  const completeStream = sawDone&&usage!==null&&typeof finishReason==='string'&&finishReason.length>0;

  return {
    content,
    toolCalls,
    finishReason,
    reportedModel,
    providerResponseId,
    providerCreated,
    usage,
    sawDone,
    settled: completeStream,
    reason:completeStream?null:!sawDone?'STREAM_TRUNCATED_NO_DONE':usage===null?'STREAM_MISSING_USAGE':'STREAM_MISSING_FINISH_REASON',
    timing: {
      firstContentMs,
      firstReasoningMs,
      latencyMs,
    },
    reasoningQuarantinedChars: reasoningChars,
  };
}
