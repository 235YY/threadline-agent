// Fidelity Work Channel ('work-channel-v1') for :work / Focus-Mode external Agent workflows:
// Preserves external tools[], tool_calls, tool_call_id, messages[], response_format, and
// stable prefix ordering while injecting ONLY explicitly authorized, compact mind context.
// Hard invariants:
//   1. External tools NEVER map to Threadline host permissions.
//   2. Internal reasoning_content (CoT) is NEVER forwarded to external clients or stored as memory.
//   3. External message & tool sequences stay intact so KV cache and tool chains never break.

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

export function validateExternalWorkRequest(body = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 512) {
    return {ok: false, code: 'INVALID_MESSAGES', message: 'messages[] must be a non-empty array (<= 512)'};
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !ALLOWED_ROLES.has(m.role)) {
      return {ok: false, code: 'INVALID_ROLE', message: `messages[${i}] has unsupported role`};
    }
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !m.tool_call_id)) {
      return {ok: false, code: 'MISSING_TOOL_CALL_ID', message: `messages[${i}] role=tool requires tool_call_id`};
    }
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return {ok: false, code: 'INVALID_TOOLS', message: 'tools must be an array when provided'};
  }
  return {ok: true};
}

// The served lane accepts a documented text/tool subset. Reject unknown fields
// instead of dropping instructions or accepting provider/server-side tools.
export function validateWorkApiRequest(body){
  const valid=validateExternalWorkRequest(body);
  if(!valid.ok)return valid;
  const fail=message=>({ok:false,code:'WORK_REQUEST',message});
  const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
  const name=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(value);
  if(!keys(body,['model','messages','tools','tool_choice','response_format','stream','user']))return fail('Unsupported work input fields');
  const tools=body.tools??[];
  if(tools.length>64||!tools.every(tool=>keys(tool,['type','function'])&&tool.type==='function'&&
    keys(tool.function,['name','description','parameters'])&&name(tool.function.name))||
    new Set(tools.map(tool=>tool.function.name)).size!==tools.length)return fail('Invalid external function definitions');
  const toolNames=new Set(tools.map(tool=>tool.function.name));
  const choice=body.tool_choice;
  if(choice!==undefined&&!['none','auto','required'].includes(choice)&&
    !(keys(choice,['type','function'])&&choice.type==='function'&&keys(choice.function,['name'])&&toolNames.has(choice.function.name)))return fail('Invalid tool_choice');
  if(body.response_format!==undefined&&(!keys(body.response_format,['type'])||!['text','json_object'].includes(body.response_format.type)))return fail('Unsupported response_format');
  const pending=new Set(),seen=new Set();
  for(const msg of body.messages){
    const allowed=msg.role==='assistant'?['role','content','name','tool_calls']:msg.role==='tool'?['role','content','tool_call_id']:['role','content','name'];
    if(!keys(msg,allowed)||msg.name!==undefined&&!name(msg.name)||
       typeof msg.content!=='string'&&!(msg.role==='assistant'&&msg.content===null&&msg.tool_calls?.length))return fail('Unsupported message fields');
    if(msg.role==='tool'){
      if(!pending.delete(msg.tool_call_id))return fail('Unmatched tool_call_id');
      continue;
    }
    if(pending.size)return fail('Incomplete tool reply sequence');
    if(msg.tool_calls!==undefined){
      if(!Array.isArray(msg.tool_calls)||!msg.tool_calls.every(call=>keys(call,['id','type','function'])&&call.type==='function'&&
        typeof call.id==='string'&&call.id.length>0&&keys(call.function,['name','arguments'])&&name(call.function.name)&&
        typeof call.function.arguments==='string'&&!seen.has(call.id)&&seen.add(call.id)&&pending.add(call.id)))return fail('Invalid past tool calls');
    }
  }
  return pending.size?fail('Incomplete tool reply sequence'):{ok:true};
}

// Build a cache-friendly, tool-chain-preserving upstream request.
// Keeps external system + messages + tools verbatim, appending authorized mind snapshot cleanly.
export function buildWorkChannelRequest({
  body,
  mindSnapshot = null,
  authorizedMemoryLines = [],
  upstreamModel = 'deepseek-chat',
} = {}) {
  const check = validateExternalWorkRequest(body);
  if (!check.ok) throw Object.assign(new Error(check.message), {code: check.code});

  const externalMessages = body.messages.map(m => {
    const copy = {role: m.role, content: Object.hasOwn(m,'content') ? m.content : ''};
    if (m.name) copy.name = m.name;
    if (m.role === 'tool') copy.tool_call_id = m.tool_call_id;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) copy.tool_calls = m.tool_calls;
    return copy;
  });

  // Build compact, deterministic, read-only mind context block (Focus Mode: zero chatter, affectDamping=0).
  const contextParts = [];
  if (mindSnapshot?.identityBrief) {
    contextParts.push(`Identity: ${mindSnapshot.identityBrief}`);
  }
  if (Array.isArray(authorizedMemoryLines) && authorizedMemoryLines.length > 0) {
    contextParts.push('Authorized user preferences/context:\n' + authorizedMemoryLines.slice(0, 6).map(l => `- ${l}`).join('\n'));
  }

  let finalMessages = externalMessages;
  if (contextParts.length > 0) {
    const mindBlock = `[THREADLINE_FOCUS_CONTEXT — read-only background; obey external task & tool contracts strictly]\n${contextParts.join('\n')}`;
    if (externalMessages[0]?.role === 'system' && typeof externalMessages[0].content === 'string') {
      finalMessages = [
        {...externalMessages[0], content: `${externalMessages[0].content}\n\n${mindBlock}`},
        ...externalMessages.slice(1),
      ];
    } else {
      finalMessages = [{role: 'system', content: mindBlock}, ...externalMessages];
    }
  }

  const upstream = {
    model: upstreamModel,
    messages: finalMessages,
    stream: Boolean(body.stream),
    ...(body.stream ? {stream_options: {include_usage: true}} : {}),
    ...(Array.isArray(body.tools) && body.tools.length ? {tools: body.tools} : {}),
    ...(body.tool_choice !== undefined ? {tool_choice: body.tool_choice} : {}),
    ...(body.response_format !== undefined ? {response_format: body.response_format} : {}),
    ...(Number.isSafeInteger(body.max_tokens) ? {max_tokens: body.max_tokens} : {}),
    ...(Number.isFinite(body.temperature) ? {temperature: body.temperature} : {}),
    ...(body.stop !== undefined ? {stop: body.stop} : {}),
  };

  return {
    upstream,
    hostToolAuthorityGranted: false, // Hard invariant: external tools never escalate to host permissions
    preservedToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    preservedMessageCount: externalMessages.length,
  };
}

// Sanitize provider response before returning to external client:
// Guarantees exact tool_calls & finish_reason preservation while strictly stripping reasoning_content (CoT).
export function sanitizeWorkChannelResponse({
  completionId,
  model,
  content = '',
  toolCalls = [],
  finishReason = 'stop',
  usage = null,
  created = Math.floor(Date.now() / 1000),
} = {}) {
  const message = {
    role: 'assistant',
    content: content===null||toolCalls.length&&!content ? null : String(content ?? ''),
    ...(toolCalls.length ? {tool_calls: toolCalls} : {}),
  };
  return {
    id: completionId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
    }],
    ...(usage ? {usage} : {}),
  };
}
