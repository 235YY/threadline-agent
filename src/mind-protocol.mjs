// Mind Scenario Operating Protocol ('mind-protocol-v1'):
// Zero-dependency formal contract defining HOW a living Threadline mind operates
// inside any external API scenario (voice call, game coop, coding agent, smart home, raw tool).
// Covers all 14 orthogonal clauses with deterministic validation and 5 built-in presets.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const MIND_PROTOCOL_FORMAT = 'mind-protocol-v1';
export const AUDIENCE_LEVELS = Object.freeze(['owner', 'friend', 'public']);
export const OUTPUT_MODES = Object.freeze(['text', 'voice', 'action']);
export const CHANNEL_MODES = Object.freeze(['auto', 'mind-native', 'task-preserving', 'transparent']);
export const MEMORY_WRITE_MODES = Object.freeze(['realtime', 'batched', 'session-crystallize', 'none']);
export const APPERCEPTION_MODES = Object.freeze(['sync', 'async', 'off']);
export const AFFECT_MODES = Object.freeze(['full', 'playful-fast-decay', 'damped-background', 'off']);

export const MIND_PROTOCOL_PRESETS = Object.freeze({
  'companion-chat': Object.freeze({
    format: MIND_PROTOCOL_FORMAT,
    id: 'companion-chat',
    label: '日常陪伴对话',
    audienceLevel: 'owner',
    channelMode: 'mind-native',
    outputMode: 'text',
    speakableOnly: false,
    actionFirst: false,
    apperception: 'async',
    affectMode: 'full',
    affectDamping: 1,
    memoryWriteMode: 'batched',
    maxSessionCrystals: 2,
    filterNoise: true,
    overwriteStateOnly: true,
    speakingCooldownMs: 0,
    maxCharsPerUtterance: 0,
    allowInterruptPartialCommit: true,
    firstTokenMaxMs: 3000,
    fillerPhrase: '',
    maxConsecutiveErrors: 3,
    allowLongContext: false,
    allowWriteSideEffects: false,
    priority: 50,
    dailyBudgetCny: 5,
  }),
  'voice-live': Object.freeze({
    format: MIND_PROTOCOL_FORMAT,
    id: 'voice-live',
    label: '实时语音通话 / 数字人',
    audienceLevel: 'owner',
    channelMode: 'mind-native',
    outputMode: 'voice',
    speakableOnly: true,
    actionFirst: false,
    apperception: 'async',
    affectMode: 'full',
    affectDamping: 1,
    memoryWriteMode: 'session-crystallize',
    maxSessionCrystals: 2,
    filterNoise: true,
    overwriteStateOnly: true,
    speakingCooldownMs: 0,
    maxCharsPerUtterance: 120,
    allowInterruptPartialCommit: true,
    firstTokenMaxMs: 1500,
    fillerPhrase: '嗯……我想想啊',
    maxConsecutiveErrors: 3,
    allowLongContext: false,
    allowWriteSideEffects: false,
    priority: 100, // Highest attention lock during live call
    dailyBudgetCny: 8,
  }),
  'game-coop': Object.freeze({
    format: MIND_PROTOCOL_FORMAT,
    id: 'game-coop',
    label: '快节奏游戏陪玩（MC / 杀戮尖塔）',
    audienceLevel: 'owner',
    channelMode: 'mind-native',
    outputMode: 'text',
    speakableOnly: true,
    actionFirst: false,
    apperception: 'async',
    affectMode: 'playful-fast-decay',
    affectDamping: 1,
    memoryWriteMode: 'session-crystallize',
    maxSessionCrystals: 2,
    filterNoise: true,
    overwriteStateOnly: true,
    speakingCooldownMs: 18_000,
    maxCharsPerUtterance: 35,
    allowInterruptPartialCommit: true,
    firstTokenMaxMs: 1500,
    fillerPhrase: '',
    maxConsecutiveErrors: 3,
    allowLongContext: false,
    allowWriteSideEffects: false,
    priority: 80,
    dailyBudgetCny: 5,
  }),
  'work-agent': Object.freeze({
    format: MIND_PROTOCOL_FORMAT,
    id: 'work-agent',
    label: '专业干活 / IDE / 长任务 Agent',
    audienceLevel: 'owner',
    channelMode: 'task-preserving',
    outputMode: 'text',
    speakableOnly: false,
    actionFirst: true,
    apperception: 'async',
    affectMode: 'damped-background',
    affectDamping: 0,
    memoryWriteMode: 'session-crystallize',
    maxSessionCrystals: 2,
    filterNoise: true,
    overwriteStateOnly: true,
    speakingCooldownMs: 0,
    maxCharsPerUtterance: 0,
    allowInterruptPartialCommit: true,
    firstTokenMaxMs: 5000,
    fillerPhrase: '',
    maxConsecutiveErrors: 3,
    allowLongContext: true,
    allowWriteSideEffects: false,
    priority: 70,
    dailyBudgetCny: 15,
  }),
  'raw-passthrough': Object.freeze({
    format: MIND_PROTOCOL_FORMAT,
    id: 'raw-passthrough',
    label: '纯净透传逃生通道 (:raw)',
    audienceLevel: 'owner',
    channelMode: 'transparent',
    outputMode: 'text',
    speakableOnly: false,
    actionFirst: true,
    apperception: 'off',
    affectMode: 'off',
    affectDamping: 0,
    memoryWriteMode: 'none',
    maxSessionCrystals: 0,
    filterNoise: true,
    overwriteStateOnly: true,
    speakingCooldownMs: 0,
    maxCharsPerUtterance: 0,
    allowInterruptPartialCommit: false,
    firstTokenMaxMs: 10_000,
    fillerPhrase: '',
    maxConsecutiveErrors: 5,
    allowLongContext: true,
    allowWriteSideEffects: false,
    priority: 10,
    dailyBudgetCny: 10,
  }),
});

const SUFFIX_TO_PRESET = Object.freeze({
  chat: 'companion-chat',
  voice: 'voice-live',
  call: 'voice-live',
  game: 'game-coop',
  work: 'work-agent',
  raw: 'raw-passthrough',
});

export function parseModelTarget(modelName = 'threadline-brain') {
  const raw = String(modelName ?? 'threadline-brain').trim();
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const suffix = raw.slice(idx + 1).toLowerCase();
    if (Object.hasOwn(SUFFIX_TO_PRESET, suffix)) {
      return {
        model: raw,
        residentId: raw.slice(0, idx),
        presetId: SUFFIX_TO_PRESET[suffix],
        explicitPreset: true,
      };
    }
  }
  return {
    model: raw || 'threadline-brain',
    residentId: raw || 'threadline-brain',
    presetId: 'companion-chat',
    explicitPreset: false,
  };
}

export function normalizeMindProtocol(input = {}, basePreset = 'companion-chat') {
  const base = Object.hasOwn(MIND_PROTOCOL_PRESETS,basePreset)?MIND_PROTOCOL_PRESETS[basePreset]:MIND_PROTOCOL_PRESETS['companion-chat'];
  const p = {...base, ...(input && typeof input === 'object' ? input : {})};
  return {
    format: MIND_PROTOCOL_FORMAT,
    id: String(p.id || base.id).trim().slice(0, 48),
    label: String(p.label || base.label).trim().slice(0, 64),
    audienceLevel: AUDIENCE_LEVELS.includes(p.audienceLevel) ? p.audienceLevel : base.audienceLevel,
    channelMode: CHANNEL_MODES.includes(p.channelMode) ? p.channelMode : base.channelMode,
    outputMode: OUTPUT_MODES.includes(p.outputMode) ? p.outputMode : base.outputMode,
    speakableOnly: Boolean(p.speakableOnly),
    actionFirst: Boolean(p.actionFirst),
    apperception: APPERCEPTION_MODES.includes(p.apperception) ? p.apperception : base.apperception,
    affectMode: AFFECT_MODES.includes(p.affectMode) ? p.affectMode : base.affectMode,
    affectDamping: Math.max(0, Math.min(1, Number.isFinite(Number(p.affectDamping)) ? Number(p.affectDamping) : base.affectDamping)),
    memoryWriteMode: MEMORY_WRITE_MODES.includes(p.memoryWriteMode) ? p.memoryWriteMode : base.memoryWriteMode,
    maxSessionCrystals: Math.max(0, Math.min(5, Math.floor(Number(p.maxSessionCrystals ?? base.maxSessionCrystals) || 0))),
    filterNoise: p.filterNoise !== false,
    overwriteStateOnly: p.overwriteStateOnly !== false,
    speakingCooldownMs: Math.max(0, Math.min(300_000, Math.floor(Number(p.speakingCooldownMs ?? base.speakingCooldownMs) || 0))),
    maxCharsPerUtterance: Math.max(0, Math.min(4000, Math.floor(Number(p.maxCharsPerUtterance ?? base.maxCharsPerUtterance) || 0))),
    allowInterruptPartialCommit: p.allowInterruptPartialCommit !== false,
    firstTokenMaxMs: Math.max(300, Math.min(30_000, Math.floor(Number(p.firstTokenMaxMs ?? base.firstTokenMaxMs) || 3000))),
    fillerPhrase: String(p.fillerPhrase ?? base.fillerPhrase).slice(0, 40),
    maxConsecutiveErrors: Math.max(1, Math.min(10, Math.floor(Number(p.maxConsecutiveErrors ?? base.maxConsecutiveErrors) || 3))),
    allowLongContext: Boolean(p.allowLongContext),
    allowWriteSideEffects: Boolean(p.allowWriteSideEffects),
    priority: Math.max(0, Math.min(100, Math.floor(Number(p.priority ?? base.priority) || 50))),
    dailyBudgetCny: Math.max(0.1, Math.min(500, Number(p.dailyBudgetCny ?? base.dailyBudgetCny) || 5)),
  };
}

export function createMindProtocolRegistry({stateFile = null} = {}) {
  const custom = new Map();
  if (stateFile && existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved?.format === 'threadline-protocol-registry-v1' && Array.isArray(saved.protocols)) {
        for (const item of saved.protocols) {
          const norm = normalizeMindProtocol(item);
          if(!Object.hasOwn(MIND_PROTOCOL_PRESETS,norm.id)&&/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(norm.id))custom.set(norm.id,norm);
        }
      }
    } catch { /* keep presets only */ }
  }

  function save() {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), {recursive: true});
    writeFileSync(stateFile, JSON.stringify({
      format: 'threadline-protocol-registry-v1',
      protocols: [...custom.values()],
    }, null, 2), 'utf8');
  }

  function resolve({protocolId = null, model = null, overrides = null} = {}) {
    const parsed = parseModelTarget(model);
    const chosenId = protocolId || parsed.presetId;
    const base = custom.get(chosenId) ?? (Object.hasOwn(MIND_PROTOCOL_PRESETS,chosenId)?MIND_PROTOCOL_PRESETS[chosenId]:null);
    if(!base)throw Object.assign(Error('Mind protocol not found'),{code:'PROTOCOL_NOT_FOUND'});
    const protocol = overrides ? normalizeMindProtocol({...base, ...overrides}, base.id) : {...base};
    return {protocol, residentId: parsed.residentId, explicitPreset: Boolean(protocolId || parsed.explicitPreset)};
  }

  function register(def) {
    const norm = normalizeMindProtocol(def);
    if(Object.hasOwn(MIND_PROTOCOL_PRESETS,norm.id)||!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(norm.id))throw Object.assign(Error('Invalid custom protocol ID'),{code:'PROTOCOL_ID'});
    custom.set(norm.id, norm);
    save();
    return norm;
  }

  function list() {
    return {
      presets: Object.values(MIND_PROTOCOL_PRESETS),
      custom: [...custom.values()],
    };
  }

  return {resolve, register, list};
}
