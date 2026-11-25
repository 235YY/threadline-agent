// Six-Station Brain API Pipeline ('brain-api-pipeline-v1'):
// Zero-dependency middleware primitives implementing Wave 1 of mind-protocol-v1:
//   1. Idempotency cache & consecutive-error circuit breaker
//   2. Three-channel traffic classifier + machine-noise memory firewall
//   3. Audience-level privacy filter & overwrite-only World State store
//   4. Output modality purifier (voice mode strips Markdown/stage brackets -> structured actions)
//   5. Duplex interrupt partial-utterance committer
//   6. Session-end crystallizer (0..2 provenance-backed memory candidates)

const NOISE_PATTERNS = [
  /起一个.{0,12}(?:标题|题目)/u,
  /生成.{0,12}(?:对话标题|简短标题|commit\s*message)/iu,
  /generate a (?:concise |short )?title/i,
  /summarize (?:this|the) conversation into a (?:short )?title/i,
  /^translate the following (?:text|code|error) (?:to|into)\b/i,
];

const PRIVATE_TAGS = new Set(['private', 'secret', 'health', 'finance', 'medical', 'password', 'personal-secret']);

export function createIdempotencyCache({ttlMs=5*60_000,maxEntries=512,clock=Date.now}={}) {
  const rows=new Map();
  function prune() {
    const now=clock();
    for(const [key,row] of rows)if(row.expiresAt<=now)rows.delete(key);
  }
  function claim(key,fingerprint,execute) {
    if(!key)return execute();
    prune();
    const prior=rows.get(key);
    if(prior){
      if(prior.fingerprint!==fingerprint)throw Object.assign(Error('Idempotency-Key already binds a different request'),{code:'IDEMPOTENCY_CONFLICT'});
      return prior.result;
    }
    if(rows.size>=maxEntries)throw Object.assign(Error('Idempotency window is full'),{code:'IDEMPOTENCY_CAPACITY'});
    const row={fingerprint,expiresAt:Infinity,result:null};
    rows.set(key,row);
    row.result=Promise.resolve().then(execute).finally(()=>{row.expiresAt=clock()+ttlMs;});
    return row.result;
  }
  return {claim,clear:()=>rows.clear()};
}

export function createCircuitBreaker({maxConsecutiveErrors=3,cooldownMs=30_000,clock=Date.now,maxEntries=128}={}) {
  const states=new Map();
  function read(key) {
    const state=states.get(key);
    if(state&&state.expiresAt>clock())return state;
    states.delete(key);
    return null;
  }
  function recordFailure(key,limit=maxConsecutiveErrors) {
    const failures=(read(key)?.failures??0)+1;
    const tripped=failures>=limit;
    states.delete(key);
    states.set(key,{failures,expiresAt:clock()+cooldownMs});
    while(states.size>maxEntries)states.delete(states.keys().next().value);
    return {tripped,failures,limit};
  }
  function retryAfter(key,limit=maxConsecutiveErrors) {
    const state=read(key);
    return state&&state.failures>=limit?Math.max(1,Math.ceil((state.expiresAt-clock())/1000)):0;
  }
  return {
    recordFailure,retryAfter,
    isTripped:(key,limit)=>retryAfter(key,limit)>0,
    recordSuccess:key=>{states.delete(key);return {tripped:false,failures:0};},
    clear:()=>states.clear(),
  };
}

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim();
    }
  }
  return '';
}

export function classifyApiRequest(body = {}, protocol = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = extractLastUserText(messages);
  const totalChars = messages.reduce((s, m) => s + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length), 0);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolMessages = messages.some(m => m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0));
  const strictJson = Boolean(body.response_format && ['json_object', 'json_schema'].includes(body.response_format.type));
  const forcedTool = body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object');

  const isNoise = protocol.filterNoise !== false && NOISE_PATTERNS.some(re => re.test(lastUser));

  if (protocol.channelMode === 'transparent' || isNoise) {
    return {
      channel: 'transparent',
      isNoise,
      strictContract: strictJson || forcedTool,
      preserveExternalHistory: true,
      allowMemoryWrite: false,
      allowPersonaFluff: false,
      reason: isNoise ? 'machine-noise-filtered' : 'protocol-transparent',
    };
  }

  if (protocol.channelMode === 'task-preserving' || hasTools || hasToolMessages || strictJson || forcedTool || totalChars > 24_000) {
    return {
      channel: 'task-preserving',
      isNoise: false,
      strictContract: strictJson || forcedTool,
      preserveExternalHistory: true,
      allowMemoryWrite: protocol.memoryWriteMode !== 'none',
      allowPersonaFluff: !(strictJson || forcedTool || protocol.actionFirst),
      reason: hasTools || hasToolMessages ? 'external-tool-chain' : strictJson ? 'strict-json-contract' : 'long-context-or-work',
    };
  }

  return {
    channel: 'mind-native',
    isNoise: false,
    strictContract: false,
    preserveExternalHistory: false,
    allowMemoryWrite: protocol.memoryWriteMode !== 'none',
    allowPersonaFluff: !protocol.actionFirst,
    reason: 'natural-companion-turn',
  };
}

// Physical privacy filter: strips private memories when audienceLevel is 'public' (or 'friend' for private-only).
export function filterMemoriesByAudience(memories = [], audienceLevel = 'owner') {
  if (!Array.isArray(memories)) return [];
  if (audienceLevel === 'owner') return memories;
  return memories.filter(m => {
    const scene = String(m?.scene ?? m?.sourceScene ?? '').toLowerCase();
    const kind = String(m?.kind ?? '').toLowerCase();
    const domains = Array.isArray(m?.domains) ? m.domains.map(d => String(d).toLowerCase()) : [];
    const tags = Array.isArray(m?.tags) ? m.tags.map(t => String(t).toLowerCase()) : [];
    const allMeta = [kind, ...domains, ...tags];

    if (m?.private === true || scene.startsWith('qq/private/')) return false;
    if (allMeta.some(x => PRIVATE_TAGS.has(x))) return false;
    if (audienceLevel === 'public' && m?.audience !== 'public') return false;
    if (audienceLevel === 'friend' && !['friend','public'].includes(m?.audience)) return false;
    return true;
  });
}

// Latest snapshot only. Scope keys are assigned by the authenticated gateway.
export function createWorldStateStore({clock=Date.now,ttlMs=30*60_000,maxEntries=128}={}) {
  const scenes=new Map();
  function read(key) {
    const value=scenes.get(key);
    if(value&&clock()-value.updatedAt<ttlMs)return value;
    scenes.delete(key);
    return null;
  }
  function upsert(sceneId,patch={}, {deadband=null}={}) {
    const prev=read(sceneId)??{state:{},updatedAt:0};
    const state={...prev.state};
    let changed=false;
    for(const [k,v] of Object.entries(patch)){
      const old=state[k];
      if(typeof v==='number'&&typeof old==='number'&&Number.isFinite(deadband?.[k])&&Math.abs(v-old)<deadband[k])continue;
      if(old!==v){state[k]=v;changed=true;}
    }
    if(Object.keys(state).length>64)throw Object.assign(Error('World state has too many fields'),{code:'WORLD_STATE_LIMIT'});
    const updatedAt=changed?clock():prev.updatedAt;
    if(changed){
      scenes.delete(sceneId);scenes.set(sceneId,{state,updatedAt});
      while(scenes.size>maxEntries)scenes.delete(scenes.keys().next().value);
    }
    return {changed,state:{...state},updatedAt};
  }
  return {upsert,get:sceneId=>{const row=read(sceneId);return row?{state:{...row.state},updatedAt:row.updatedAt}:{state:{},updatedAt:0};},
    clear:sceneId=>scenes.delete(sceneId),clearAll:()=>scenes.clear()};
}

// Output Modality Purifier: in 'voice' or speakableOnly mode, strips Markdown & stage-direction brackets
// so TTS never reads "**" or "（轻轻摇了摇尾巴）" out loud, extracting actions cleanly instead.
export function purifyOutputForModality(rawText, {outputMode = 'text', speakableOnly = false, maxChars = 0} = {}) {
  const text = String(rawText ?? '');
  if (outputMode !== 'voice' && !speakableOnly) {
    return {text, actions: [], modified: false};
  }

  const actions = [];
  let clean = text
    // Extract Chinese or English stage directions like （摇了摇尾巴） or (*wags tail*)
    .replace(/[（(]\s*\*?([^()（）]{1,40}?)\*?\s*[）)]/gu, (_m, inner) => {
      const s = inner.trim();
      if (s && /摇|笑|眨|点头|叹气|凑近|抱|拍|尾巴|耳|wag|smile|nod|sigh|blush/iu.test(s)) {
        actions.push({type: 'expression', cue: s});
        return '';
      }
      return _m;
    })
    // Strip code blocks & Markdown formatting
    .replace(/```[\s\S]*?```/g, '（略去代码）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (maxChars > 0 && clean.length > maxChars) {
    clean = clean.slice(0, maxChars).replace(/[，,、；;：:\s]+$/u, '') + '…';
  }

  return {text: clean, actions, modified: clean !== text};
}

// Duplex interrupt helper: commits ONLY the exact spoken prefix before interruption.
export function buildPartialCommitRecord({sceneId, spokenText, fullPlannedText = '', interrupted = false, at = Date.now()} = {}) {
  const committed = String(spokenText ?? '').trim();
  return {
    sceneId: String(sceneId || 'default'),
    committedText: committed,
    interrupted: Boolean(interrupted),
    discardedChars: Math.max(0, String(fullPlannedText ?? '').length - committed.length),
    at,
  };
}

// Session-end crystallizer: extracts 0..maxCrystals provenance-backed memory candidates from a session's turns.
export function crystallizeSession({
  sceneId = 'default',
  protocol = {},
  turns = [],
  now = Date.now(),
} = {}) {
  const maxCrystals = Math.max(0, Math.min(2, protocol.maxSessionCrystals ?? 2));
  if (protocol.memoryWriteMode === 'none' || maxCrystals === 0 || !Array.isArray(turns) || !turns.length) {
    return {format: 'mind-session-crystals-v1', sceneId, crystallizedAt: now, crystals: [], discardedTurns: turns?.length ?? 0};
  }

  const scored = [];
  for (const t of turns) {
    if (t?.ephemeral === true || t?.isNoise === true) continue;
    const sourceRefs=Array.isArray(t?.source_refs)?t.source_refs.filter(ref=>typeof ref?.id==='string'&&ref.id&&Number.isSafeInteger(ref.revision)&&ref.revision>0).slice(0,8):[];
    if(!sourceRefs.length)continue;
    const body = String(t?.summary ?? t?.text ?? '').trim();
    if (body.length < 8) continue;
    let score = 0;
    if (t?.milestone === true) score += 3;
    if (/(?:通关|赢了|搞定|修复|记住|喜欢|讨厌|约定|决定了|完成|失败|翻车)/u.test(body)) score += 2;
    if (body.length >= 20) score += 1;
    if (score >= 2) {
      scored.push({
        score,
        kind: t?.kind || 'session-highlight',
        text: body.slice(0, 180),
        source_refs: sourceRefs.map(({id,revision})=>({id,revision})),
        playful: protocol.affectMode === 'playful-fast-decay',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const crystals = scored.slice(0, maxCrystals).map(({score: _s, ...rest}) => rest);
  return {
    format: 'mind-session-crystals-v1',
    sceneId,
    crystallizedAt: now,
    crystals,
    discardedTurns: Math.max(0, turns.length - crystals.length),
  };
}
