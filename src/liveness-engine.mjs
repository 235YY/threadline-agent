// Four-Dimensional Liveness Engine ('liveness-v1'):
// Zero third-party dependencies, zero extra LLM calls.
//   1. Speech liveness  : natural multi-bubble splitting + human typing pacing (never splits code/tables/work docs)
//   2. Reaction liveness: anti-interruption input debounce merger + Limbic emotion aura cues for mascot stage
//   3. Action liveness  : baseline-deviation proactive nudge evaluator (never a rigid alarm clock; respects Curtain Mode)
//   4. Thinking liveness: bounded Inner Thoughts pool with natural motivation decay (arXiv:2501.00383 inspired)

const STIFF_TRAILING_CLICHES = [
  /[，,。！!\s]*(?:希望(?:这些|以上)?(?:能)?帮到你|如果(?:你)?还有(?:任何)?(?:其他)?问题[，,]?请随时告诉我|祝你(?:今天)?(?:一切顺利|愉快))[！!。.]*$/u,
];

export function looksLikeStructuredWork(text) {
  if (typeof text !== 'string') return false;
  if (text.length > 380) return true;
  if (text.includes('```')) return true;
  if (/^\s*\|.+\|\s*$/m.test(text)) return true;
  if (/^\s*(?:[-*•]|\d+\.)\s+/m.test(text) && (text.match(/\n/g)?.length ?? 0) >= 2) return true;
  if (/^#{1,4}\s+/m.test(text)) return true;
  return false;
}

export function splitNaturalBubbles(rawText, {maxBubbles = 3, stripCliches = true} = {}) {
  maxBubbles=Number.isSafeInteger(maxBubbles)?Math.max(1,Math.min(3,maxBubbles)):3;
  let text = String(rawText ?? '').trim();
  if (!text) return [];

  if (looksLikeStructuredWork(text)) {
    return [{text, delayMs: 0, structured: true}];
  }

  if (stripCliches) {
    for (const re of STIFF_TRAILING_CLICHES) {
      const cleaned = text.replace(re, '').trim();
      if (cleaned.length >= 6) text = cleaned;
    }
  }

  // Prefer natural paragraph breaks first, otherwise gentle sentence boundaries
  let parts = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && text.length >= 26) {
    const sentences = text.match(/[^。！？!?~～]*[。！？!?~～]+|[^。！？!?~～]+$/gu)?.map(s => s.trim()).filter(Boolean) ?? [text];
    if (sentences.length >= 2) {
      parts = [];
      let buf = '';
      for (const s of sentences) {
        if (!buf) {
          buf = s;
        } else if ((buf + s).length <= 24 && parts.length < maxBubbles - 1) {
          buf += s;
        } else {
          parts.push(buf);
          buf = s;
        }
      }
      if (buf) parts.push(buf);
    }
  }

  // Cap to maxBubbles by merging tail
  if (parts.length > maxBubbles) {
    const head = parts.slice(0, maxBubbles - 1);
    const tail = parts.slice(maxBubbles - 1).join(' ');
    parts = [...head, tail];
  }

  return parts.map((chunk, idx) => ({
    text: chunk,
    delayMs: idx === 0 ? 0 : Math.min(1450, Math.max(420, chunk.length * 28)),
    structured: false,
  }));
}

// Anti-interruption debounce merger: waits briefly when user types multiple short bursts.
export function createDebounceMerger({windowMs = 1800, maxWaitMs = 6000, onFlush} = {}) {
  const queues = new Map();

  function flush(key) {
    const q = queues.get(key);
    if (!q) return null;
    if (q.timer) clearTimeout(q.timer);
    queues.delete(key);
    const merged = q.items.map(x => x.text).join('\n');
    const payload = {key, text: merged, count: q.items.length, items: q.items};
    onFlush?.(payload);
    return payload;
  }

  function push(key, text, meta = null) {
    const now = Date.now();
    const safeText = String(text ?? '').trim();
    if (!safeText) return null;
    if (windowMs <= 0) {
      const payload = {key, text: safeText, count: 1, items: [{text: safeText, at: now, meta}]};
      onFlush?.(payload);
      return payload;
    }
    let q = queues.get(key);
    if (!q) {
      q = {firstAt: now, items: [], timer: null};
      queues.set(key, q);
    }
    q.items.push({text: safeText, at: now, meta});
    if (q.timer) clearTimeout(q.timer);
    const remaining = Math.max(0, maxWaitMs - (now - q.firstAt));
    const wait = Math.min(windowMs, remaining);
    q.timer = setTimeout(() => flush(key), wait);
    return {queued: true, pendingCount: q.items.length};
  }

  function clearAll() {
    for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
    queues.clear();
  }

  return {push, flush, clearAll, pendingKeys: () => [...queues.keys()]};
}

// Map Limbic affect/mood to subtle non-verbal visual aura cues for the mascot stage.
export function emotionAuraProfile(glassbox = null) {
  const affect = glassbox?.affect ?? null;
  const top = Array.isArray(affect?.emotions) && affect.emotions.length
    ? [...affect.emotions].sort((a, b) => (b.intensity ?? b.value ?? 0) - (a.intensity ?? a.value ?? 0))[0]
    : null;
  const tag = String(top?.name ?? '').toLowerCase();
  const valence = affect?.mood?.valence ?? 0;
  const arousal = affect?.mood?.arousal ?? 0;

  let key = 'neutral';
  if (tag.includes('joy') || tag.includes('happy') || tag.includes('warm') || valence > 0.3) key = 'happy';
  else if (tag.includes('excit') || tag.includes('curio') || (valence > 0.15 && arousal > 0.25)) key = 'curious';
  else if (tag.includes('sad') || tag.includes('melanch') || valence < -0.25) key = 'soft-sad';
  else if (tag.includes('sleep') || tag.includes('tired') || arousal < -0.3) key = 'sleepy';

  const profiles = {
    happy: {tag: 'happy', color: 'rgba(96, 165, 250, 0.34)', breathSec: 3.4, caption: '心情亮晶晶的，正开心陪着你'},
    curious: {tag: 'curious', color: 'rgba(56, 189, 248, 0.36)', breathSec: 2.8, caption: '正好奇地凑近看你在忙什么'},
    'soft-sad': {tag: 'soft-sad', color: 'rgba(129, 140, 248, 0.28)', breathSec: 5.2, caption: '轻轻守在旁边，随时可以抱抱'},
    sleepy: {tag: 'sleepy', color: 'rgba(148, 163, 184, 0.22)', breathSec: 6.0, caption: '有点犯困了，安静打个盹'},
    neutral: {tag: 'neutral', color: 'rgba(59, 130, 246, 0.22)', breathSec: 4.2, caption: '安静待在桌角陪着你'},
  };
  return profiles[key] ?? profiles.neutral;
}

// Baseline-deviation proactive nudge evaluator (never acts like a rigid timer alarm).
export function evaluateBaselineNudge({
  sensoryStatus = null,
  now = Date.now(),
  timezoneMinutes=null,
  lastNudgeAt = 0,
  minCooldownMs = 90 * 60 * 1000,
  lateNightStartHour = 1,
  lateNightEndHour = 5,
  focusThresholdMin = 120,
} = {}) {
  if (!sensoryStatus || sensoryStatus.curtain || sensoryStatus.effectiveLevel === 'L0') {
    return {shouldNudge: false, reason: 'SENSORY_OFF_OR_CURTAIN'};
  }
  if (lastNudgeAt && now - lastNudgeAt < minCooldownMs) {
    return {shouldNudge: false, reason: 'COOLDOWN_ACTIVE'};
  }

  const signals = Array.isArray(sensoryStatus.activeSignals) ? sensoryStatus.activeSignals : [];
  if (!signals.length) return {shouldNudge: false, reason: 'NO_ACTIVE_SIGNALS'};

  const hour=Number.isSafeInteger(timezoneMinutes)?new Date(now+timezoneMinutes*60000).getUTCHours():new Date(now).getHours();
  const act = signals.find(s => s.kind === 'activity');
  if (act && hour >= lateNightStartHour && hour < lateNightEndHour) {
    return {
      shouldNudge: true,
      kind: 'late-night-care',
      reason: 'LATE_NIGHT_ACTIVE',
      hint: `现在已经凌晨 ${hour} 点多，你还在 ${act.app || '电脑前'} 忙，可以轻声关心一下别熬太晚。`,
    };
  }

  // Long focus deviation (e.g. "120 分钟" or "2 小时")
  if (act?.summary) {
    const minMatch = act.summary.match(/(\d+)\s*分钟/);
    const hrMatch = act.summary.match(/(\d+(?:\.\d+)?)\s*小时/);
    const mins = minMatch ? Number(minMatch[1]) : (hrMatch ? Math.round(Number(hrMatch[1]) * 60) : 0);
    if (mins >= focusThresholdMin) {
      return {
        shouldNudge: true,
        kind: 'long-focus-break',
        reason: 'LONG_FOCUS_DEVIATION',
        hint: `你已经连续专注了约 ${mins} 分钟，可以顺口提醒歇一下眼睛、喝口水。`,
      };
    }
  }

  const wearable = signals.find(s => s.kind === 'wearable');
  if (wearable?.summary && /(?:睡眠不足|熬夜|心率偏高|疲劳)/.test(wearable.summary)) {
    return {
      shouldNudge: true,
      kind: 'wearable-care',
      reason: 'WEARABLE_DEVIATION',
      hint: `体征摘要提示「${wearable.summary}」，找个温和的时机轻声关心一下。`,
    };
  }

  return {shouldNudge: false, reason: 'WITHIN_NORMAL_BASELINE'};
}

// Bounded Inner Thoughts pool with natural time decay (arXiv:2501.00383 inspired).
export function createInnerThoughtsPool({maxItems = 8, decayPerHour = 0.12, clock = Date.now} = {}) {
  const items = [];
  let nextId=0;
  maxItems=Number.isSafeInteger(maxItems)?Math.max(1,Math.min(16,maxItems)):8;

  function prune() {
    const now = clock();
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const hours = Math.max(0, (now - it.createdAt) / 3600_000);
      const currentMotivation = it.motivation - hours * decayPerHour;
      if (it.expressed || currentMotivation <= 0.05 || now >= it.expiresAt) {
        items.splice(i, 1);
      }
    }
  }

  function add({text, topic = '', motivation = 0.65, ttlMs = 6 * 3600_000} = {}) {
    prune();
    const safeText = String(text ?? '').trim().slice(0, 220);
    if (!safeText) return null;
    const now = clock();
    const entry = {
      id: `th_${now}_${nextId++}`,
      text: safeText,
      topic: String(topic ?? '').trim().slice(0, 48),
      motivation:Math.max(0,Math.min(1,Number.isFinite(motivation)?motivation:0.65)),
      createdAt: now,
      expiresAt:now+Math.max(60_000,Math.min(24*3600_000,Number.isFinite(ttlMs)?ttlMs:6*3600_000)),
      expressed: false,
    };
    items.push(entry);
    while (items.length > maxItems) items.shift();
    return {...entry};
  }

  function pickReady({minMotivation = 0.72, contextText = ''} = {}) {
    prune();
    const now = clock();
    const ctx = String(contextText ?? '').toLowerCase();
    let best = null;
    let bestScore = -1;
    for (const it of items) {
      const hours = Math.max(0, (now - it.createdAt) / 3600_000);
      let score = it.motivation - hours * decayPerHour;
      if (it.topic && ctx && ctx.includes(it.topic.toLowerCase())) score += 0.25;
      if (score >= minMotivation && score > bestScore) {
        best = it;
        bestScore = score;
      }
    }
    if (!best) return null;
    best.expressed = true;
    return {...best, effectiveScore: Number(bestScore.toFixed(3))};
  }

  function list() {
    prune();
    return items.map(it => ({...it}));
  }

  return {add, pickReady, list};
}
