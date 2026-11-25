// Opt-in Phase 1 transport wire layout ('staged-v1'):
// Reorders an already-sealed intent packet into three cache-friendly layers
// without altering ContinuitySession, handles, permissions, or packetId contracts:
//   Layer 0: Stable prefix (system rules + identity + persona style + tool table)
//   Layer 1: Bounded, scene-isolated pure dialogue history (batch-windowed, no volatile ago/reminders)
//   Layer 2: Fresh per-turn cognitive snapshot (states/personal_state, permissions/sendScope,
//            workbench/materials, associations/reminders, lookup, mood, timeFeel, current, packetId last)
// Default remains 'legacy' (OFF). Any error or budget overflow falls back cleanly to 'legacy'.

import {canonical} from './contracts.mjs';

export const WIRE_LAYOUTS = Object.freeze(['legacy', 'staged-v1']);

export const DEFAULT_STAGED_OPTIONS = Object.freeze({
  maxHistoryTurns: 24,
  maxHistoryBytes: 12000,
  retainOnRoll: 12,
  provider: 'auto',
  anthropicCacheControl: false,
});

export function resolveWireLayout(value) {
  if (value === 'staged-v1') return 'staged-v1';
  return 'legacy';
}

function utf8Bytes(text) {
  return Buffer.byteLength(typeof text === 'string' ? text : JSON.stringify(text ?? ''), 'utf8');
}

function itemRefKey(item) {
  if (item?.ref?.id) return `${item.ref.id}@${item.ref.revision ?? 0}`;
  return `${item?.role ?? 'u'}:${item?.at ?? 0}:${String(item?.text ?? '').slice(0, 48)}`;
}

// Deterministic JSON serialization that preserves an explicit top-level key order
// while sorting nested object keys canonically (so packetId stays dead last).
function stringifyWithTopOrder(obj, preferredOrder = []) {
  const keys = Object.keys(obj);
  const ordered = [];
  for (const k of preferredOrder) {
    if (Object.hasOwn(obj, k) && obj[k] !== undefined) ordered.push(k);
  }
  const rest = keys.filter(k => !ordered.includes(k) && obj[k] !== undefined).sort();
  const finalKeys = [...ordered.filter(k => k !== 'packetId'), ...rest.filter(k => k !== 'packetId')];
  if (Object.hasOwn(obj, 'packetId') && obj.packetId !== undefined) finalKeys.push('packetId');
  return '{' + finalKeys.map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',') + '}';
}

// Extract turn-volatile instruction suffixes that intentPacket() occasionally appends
// to system prompt so Layer 0 system prompt remains byte-identical across turns.
function splitVolatileInstructionSuffixes(instruction) {
  if (typeof instruction !== 'string') return {baseInstruction: '', turnNotes: []};
  let base = instruction;
  const turnNotes = [];

  const lookupMarker = '\n\n查阅结果在 lookup.done。';
  const lookupIdx = base.indexOf(lookupMarker);
  if (lookupIdx !== -1) {
    const rest = base.slice(lookupIdx + 2);
    const nextDouble = rest.indexOf('\n\n');
    const note = nextDouble === -1 ? rest : rest.slice(0, nextDouble);
    turnNotes.push(note.trim());
    base = base.slice(0, lookupIdx) + (nextDouble === -1 ? '' : rest.slice(nextDouble));
  }

  const capMarker = '\n\n桌面快满了';
  const capIdx = base.indexOf(capMarker);
  if (capIdx !== -1) {
    const rest = base.slice(capIdx + 2);
    const nextDouble = rest.indexOf('\n\n');
    const note = nextDouble === -1 ? rest : rest.slice(0, nextDouble);
    turnNotes.push(note.trim());
    base = base.slice(0, capIdx) + (nextDouble === -1 ? '' : rest.slice(nextDouble));
  }

  return {baseInstruction: base.trimEnd(), turnNotes};
}

// Bounded in-memory per-scene batch window tracker.
// Never shifts 1-by-1; rolls forward in batches only when count or byte cap is exceeded.
export function createSceneWindowTracker({maxScenes = 256, initialAnchor = null} = {}) {
  const anchors = new Map();

  function touch(key, entry) {
    anchors.delete(key);
    anchors.set(key, entry);
    while (anchors.size > maxScenes) {
      const oldest = anchors.keys().next().value;
      anchors.delete(oldest);
    }
  }

  function formatHistoryMessage(item, matById) {
    const isUser = item.role === 'user';
    const who = isUser
      ? (item.senderName || item.sender || 'user')
      : '你';
    const matBody = item.bodySource?.path === 'materials'
      ? matById.get(itemRefKey({ref:item.bodySource.ref}))?.record?.body
      : null;
    const bodyText = item.text ?? matBody ?? (item.bodySource?.path === 'current' ? '(见 current)' : '(见上下文)');
    return {
      role: isUser ? 'user' : 'assistant',
      content: isUser ? `[${who}] ${bodyText}` : String(bodyText),
    };
  }

  function select(sceneKey, sceneItems, opts = {}, matById = new Map()) {
    const maxHistoryTurns = Math.max(4, Math.min(50, opts.maxHistoryTurns ?? DEFAULT_STAGED_OPTIONS.maxHistoryTurns));
    const maxHistoryBytes = Math.max(1024, Math.min(32768, opts.maxHistoryBytes ?? DEFAULT_STAGED_OPTIONS.maxHistoryBytes));
    const retainOnRoll = Math.max(2, Math.min(maxHistoryTurns - 1, opts.retainOnRoll ?? DEFAULT_STAGED_OPTIONS.retainOnRoll));

    if (!sceneItems.length) {
      return {messages: [], count: 0, bytes: 0, rolled: false, anchorKey: null};
    }

    const existing = anchors.get(sceneKey) ?? (initialAnchor ? {anchorKey:initialAnchor} : null);
    let startIdx = -1;
    if (existing?.anchorKey) {
      startIdx = sceneItems.findIndex(it => itemRefKey(it) === existing.anchorKey);
    }

    let rolled = false;
    if (startIdx === -1) {
      // Cold start, scene switch, or previous anchor fell off the 50-item store window.
      startIdx = sceneItems.length > maxHistoryTurns
        ? Math.max(0, sceneItems.length - retainOnRoll)
        : 0;
      if (existing) rolled = true;
    }

    let selected = sceneItems.slice(startIdx);
    let formatted = selected.map(it => formatHistoryMessage(it, matById));
    let bytes = formatted.reduce((s, m) => s + utf8Bytes(m.content) + 24, 0);

    if (selected.length > maxHistoryTurns || bytes > maxHistoryBytes) {
      rolled = true;
      // Batch-roll forward to keep at most retainOnRoll newest items within byte budget.
      let keep = Math.min(retainOnRoll, selected.length);
      selected = selected.slice(-keep);
      formatted = selected.map(it => formatHistoryMessage(it, matById));
      bytes = formatted.reduce((s, m) => s + utf8Bytes(m.content) + 24, 0);
      while (selected.length && bytes > maxHistoryBytes) {
        const drop = Math.max(1, Math.floor(selected.length / 2));
        selected = selected.slice(drop);
        formatted = selected.map(it => formatHistoryMessage(it, matById));
        bytes = formatted.reduce((s, m) => s + utf8Bytes(m.content) + 24, 0);
      }
    }

    const anchorKey = selected.length ? itemRefKey(selected[0]) : null;
    if (anchorKey) touch(sceneKey, {anchorKey, updatedAt: Date.now()});

    return {
      messages: formatted,
      count: formatted.length,
      bytes,
      rolled,
      anchorKey,
    };
  }

  return {
    select,
    clear: () => anchors.clear(),
    size: () => anchors.size,
    getAnchor: key => anchors.get(key)?.anchorKey ?? null,
  };
}

function coalesceAdjacentRoles(messages) {
  const out = [];
  for (const m of messages) {
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1] = {
        role: m.role,
        content: `${out[out.length - 1].content}\n${m.content}`,
      };
    } else {
      out.push(m);
    }
  }
  return out;
}

const LAYER2_PREFERRED_ORDER = [
  'time',
  'timeFeel',
  'homeOrientation',
  'mood',
  'feltSense',
  'sendScope',
  'hostFeedback',
  'states',
  'judgments',
  'unresolved',
  'memoryStats',
  'goals',
  'priorSteps',
  'work',
  'attention',
  'materials',
  'reminders',
  'anchors',
  'lessons',
  'lookup',
  'person',
  'elsewhere',
  'recentTools',
  'lastAction',
  'turnNotes',
  'current',
  'packetId',
];

// Reflection has no scene history to freeze. Reuse the actual sealed instruction
// and put only already-delivered static profile fields before the changing JSON.
export function buildStagedReflectionMessages(packet,verified){
  const legacy={applied:false,messages:verified.messages};
  if(packet.stage!=='reflection'||packet.payload?.internal?.kind==='autonomy')return legacy;
  const [system,user]=verified.messages;
  const data=JSON.parse(user.content);
  const content=stringifyWithTopOrder(data,['identity','style']);
  const messages=[system,{...user,content}];
  if(utf8Bytes(messages)>packet.budgetBytes)return {...legacy,fallback:true};
  return {applied:true,messages,meta:{variant:'reflection-prefix-v1',
    layer0Bytes:utf8Bytes(system.content),layer1Count:0,layer1Bytes:0,layer2Bytes:utf8Bytes(content)}};
}

export function buildStagedMessages({wire, packet, tracker = null, options = {}} = {}) {
  const opts = {...DEFAULT_STAGED_OPTIONS, ...(options ?? {})};
  const fallbackMessages = wire?.messages ?? packet?.messages ?? [];

  if (!wire || !Array.isArray(wire.messages) || wire.messages.length !== 2) {
    return {
      applied: false,
      wireLayout: 'legacy',
      fallback: false,
      reason: 'non-intent-wire',
      messages: fallbackMessages,
      meta: null,
    };
  }

  const p = packet?.payload ?? wire.basePacket?.payload ?? null;
  if (!p || p.internal?.kind === 'autonomy' || !p.current) {
    return {
      applied: false,
      wireLayout: 'legacy',
      fallback: false,
      reason: 'autonomy-or-non-event',
      messages: fallbackMessages,
      meta: null,
    };
  }

  try {
    const rawUser = wire.messages[1]?.content;
    if (typeof rawUser !== 'string') throw new Error('expected string user wire payload');
    const parsed = JSON.parse(rawUser);
    if (parsed?.packetId !== wire.packetId || !parsed?.view || typeof parsed.view !== 'object') {
      throw new Error('wire packetId/view mismatch');
    }

    const view = parsed.view;
    const {baseInstruction, turnNotes} = splitVolatileInstructionSuffixes(wire.instruction ?? wire.messages[0]?.content ?? '');

    // Layer 0: Strictly stable prefix (system instructions + identity + persona style + tools).
    const stableContext = {};
    if (view.you !== undefined) stableContext.you = view.you;
    if (view.style !== undefined) stableContext.style = view.style;
    if (view.tools !== undefined) stableContext.tools = view.tools;

    const stableJson=opts.legacyStableProfileOrder?canonical(stableContext):stringifyWithTopOrder(stableContext,['you','style','tools']);
    const layer0Text = Object.keys(stableContext).length > 0
      ? `${baseInstruction}\n\n中间消息是本会话的历史。只处理最后一个 JSON 中的 current，引用和权限以本轮交付为准。\n\n[STABLE_CONTEXT]\n${stableJson}`
      : baseInstruction;

    // Layer 1: Bounded, scene-isolated pure dialogue history (derived from continuity.recent.items).
    const cur = p.current;
    const curScene = cur.scene ?? null;
    const subjectId = p.continuity?.subject?.id ?? 'default';
    if (typeof curScene !== 'string' || !curScene || curScene === 'global') {
      return {applied:false, wireLayout:'legacy', fallback:false, reason:'no-conversation-scene', messages:fallbackMessages, meta:null};
    }
    const sceneKey = canonical([subjectId, curScene]);
    const matById = new Map((p.materials ?? []).filter(m => m.ref?.id).map(m => [itemRefKey(m), m]));

    const rawRecent = Array.isArray(p.continuity?.recent?.items) ? p.continuity.recent.items : [];
    const sceneItems = rawRecent.filter(it => {
      if (it?.ref?.id === cur.id && it?.ref?.revision === cur.revision) return false;
      return it?.scene === curScene && ['user', 'her', 'assistant'].includes(it?.role);
    });

    const activeTracker = tracker ?? createSceneWindowTracker();
    const layer1Selection = activeTracker.select(sceneKey, sceneItems, opts, matById);
    const useAnthropicCache = opts.provider === 'anthropic' || opts.anthropicCacheControl === true;
    const layer1Messages = useAnthropicCache
      ? coalesceAdjacentRoles(layer1Selection.messages)
      : layer1Selection.messages;

    // Layer 2: Fresh per-turn cognitive packet (states/personal_state, sendScope, workbench,
    // materials, reminders, lookup, mood, timeFeel, current, and packetId at the very end).
    const dynamicView = {};
    for (const [k, v] of Object.entries(view)) {
      if (k === 'you' || k === 'style' || k === 'tools' || k === 'recent') continue;
      dynamicView[k] = v;
    }
    if (turnNotes.length > 0) dynamicView.turnNotes = turnNotes;
    dynamicView.packetId = wire.packetId;

    const layer2Text = stringifyWithTopOrder(dynamicView, LAYER2_PREFERRED_ORDER);

    // Build final provider-ready message list.
    const messages = [];
    if (useAnthropicCache) {
      messages.push({
        role: 'system',
        content: [{type: 'text', text: layer0Text, cache_control: {type: 'ephemeral'}}],
      });
      for (let i = 0; i < layer1Messages.length; i++) {
        const m = layer1Messages[i];
        if (i === layer1Messages.length - 1) {
          messages.push({
            role: m.role,
            content: [{type: 'text', text: m.content, cache_control: {type: 'ephemeral'}}],
          });
        } else {
          messages.push(m);
        }
      }
      messages.push({role: 'user', content: layer2Text});
    } else {
      messages.push({role: 'system', content: layer0Text});
      for (const m of layer1Messages) messages.push(m);
      messages.push({role: 'user', content: layer2Text});
    }

    // Sanity check: final message must be user JSON containing exact packetId, within budget.
    const last = messages[messages.length - 1];
    if (last?.role !== 'user' || typeof last.content !== 'string') {
      throw new Error('layer2 user message invalid');
    }
    const verifyParsed = JSON.parse(last.content);
    if (verifyParsed.packetId !== wire.packetId) {
      throw new Error('layer2 packetId verification failed');
    }

    const layer0Bytes = utf8Bytes(layer0Text);
    const layer1Bytes = layer1Selection.bytes;
    const layer2Bytes = utf8Bytes(layer2Text);
    const totalBytes = utf8Bytes(messages);
    const budgetBytes = Number.isSafeInteger(wire.budgetBytes) ? wire.budgetBytes : 65536;

    if (totalBytes > budgetBytes) {
      return {
        applied: false,
        wireLayout: 'legacy',
        fallback: true,
        reason: 'budget-exceeded',
        messages: fallbackMessages,
        meta: {
          layer0Bytes,
          layer1Count: layer1Messages.length,
          layer1Bytes,
          layer2Bytes,
          totalBytes,
          budgetBytes,
          rolled: layer1Selection.rolled,
          sceneKey,
          fallback: true,
        },
      };
    }

    return {
      applied: true,
      wireLayout: 'staged-v1',
      fallback: false,
      reason: null,
      messages,
      meta: {
        layer0Bytes,
        layer1Count: layer1Messages.length,
        layer1Bytes,
        layer2Bytes,
        totalBytes,
        budgetBytes,
        rolled: layer1Selection.rolled,
        anchorKey: layer1Selection.anchorKey,
        variant:opts.legacyStableProfileOrder?'intent-staged-v1':'intent-profile-prefix-v2',
        sceneKey,
        anthropicCacheControl: useAnthropicCache,
        fallback: false,
      },
    };
  } catch (err) {
    return {
      applied: false,
      wireLayout: 'legacy',
      fallback: true,
      reason: String(err?.message ?? err).slice(0, 160),
      messages: fallbackMessages,
      meta: {fallback: true, error: String(err?.message ?? err).slice(0, 160)},
    };
  }
}
