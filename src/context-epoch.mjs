// Epoch-Frozen KV-Cache Context Engine + Sleep-Time Handoff (v2.2.0)
// Inspired by Claude Code Prompt Caching/Compaction & Letta Memory Blocks:
// 1. Frozen Static Prefix (System + Persona + Skills + Core Pinboard + Yesterday Handoff):
//    NEVER mutated mid-epoch, achieving 85-95% prefix KV-cache hit rate.
// 2. Append-Only Day Epoch Buffer:
//    Never slides/evicts the oldest single message mid-day (which breaks KV cache!).
// 3. Volatile Tail Capsule:
//    Appends per-turn timeFeel / Limbic / retrieved recall snippets at the tail only.
// 4. Dual Compaction:
//    - Auto-Dream nightly rollover: distills "Yesterday Handoff" + clears day buffer cleanly.
//    - 80% Watermark Mid-Day Half-Compaction: folds older 50% into a digest block while warm.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from './contracts.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  // Conservative mixed CJK/ASCII estimator
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x2e7f) cjk++;
  }
  const ascii = s.length - cjk;
  return Math.ceil(cjk * 1.15 + ascii / 3.6);
}

export function localDayKey(now = Date.now(), timezoneMinutes = 480) {
  const d = new Date(now + timezoneMinutes * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function summarizeTurnsRuleBased(turns) {
  if (!turns.length) return '';
  const highlights = [];
  for (const t of turns) {
    const role = t.role === 'user' ? '主人' : '自己';
    const clean = String(t.content || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    highlights.push(`- ${role}：${clean.slice(0, 90)}${clean.length > 90 ? '…' : ''}`);
  }
  const head = highlights.slice(0, 4);
  const tail = highlights.length > 6 ? highlights.slice(-4) : highlights.slice(4);
  const lines = [...head, ...(highlights.length > 8 ? [`- （中间省略 ${highlights.length - 8} 条日常对话）`] : []), ...tail];
  return lines.join('\n').slice(0, 1200);
}

export function createContextEpochEngine({residentDir, timezoneMinutes = 480, maxTokens = 32000} = {}) {
  const file = join(residentDir, 'context-epoch.json');

  function load() {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.turns)) return parsed;
      } catch { /* fall through */ }
    }
    return {
      version: 1,
      epochId: localDayKey(Date.now(), timezoneMinutes),
      frozenPrefix: {
        corePinboard: '',
        yesterdayHandoff: '',
        handoffDay: null,
      },
      compactedDigest: '',
      turns: [],
      stats: {
        totalRequests: 0,
        estimatedPrefixTokens: 0,
        estimatedCachedTokens: 0,
        compactionCount: 0,
        lastRolloverAt: null,
      },
    };
  }

  let state = load();
  const persist = () => writeLedgerAtomically(file, state);

  function refreshFrozenPrefix({corePinboard, yesterdayHandoff, handoffDay} = {}) {
    if (typeof corePinboard === 'string') state.frozenPrefix.corePinboard = corePinboard.slice(0, 4000);
    if (typeof yesterdayHandoff === 'string') state.frozenPrefix.yesterdayHandoff = yesterdayHandoff.slice(0, 2000);
    if (handoffDay !== undefined) state.frozenPrefix.handoffDay = handoffDay;
    persist();
  }

  function appendTurn({role, content, tailCapsule = '', ts = Date.now()}) {
    ensure(role === 'user' || role === 'assistant', 'EPOCH_ROLE', 'role must be user or assistant');
    const clean = String(content || '').trim();
    if (!clean) return;
    state.turns.push({
      role,
      content: clean.slice(0, 8000),
      tailCapsule: String(tailCapsule || '').slice(0, 800),
      ts,
    });
    persist();
  }

  function currentTokens({systemPrompt = ''} = {}) {
    let total = estimateTokens(systemPrompt)
      + estimateTokens(state.frozenPrefix.corePinboard)
      + estimateTokens(state.frozenPrefix.yesterdayHandoff)
      + estimateTokens(state.compactedDigest);
    for (const t of state.turns) {
      total += estimateTokens(t.content) + estimateTokens(t.tailCapsule);
    }
    return total;
  }

  // Build append-only KV-cache-friendly messages array
  function assemblePrompt({systemPrompt = '', currentInput = '', tailCapsule = '', maxBudgetTokens = maxTokens} = {}) {
    const staticParts = [systemPrompt];
    if (state.frozenPrefix.corePinboard) {
      staticParts.push(`【核心置顶记忆块（当日锁定）】\n${state.frozenPrefix.corePinboard}`);
    }
    if (state.frozenPrefix.yesterdayHandoff) {
      staticParts.push(`【昨日交接与未完话题（${state.frozenPrefix.handoffDay || '此前'}）】\n${state.frozenPrefix.yesterdayHandoff}`);
    }
    const frozenSystem = staticParts.filter(Boolean).join('\n\n');

    const messages = [{role: 'system', content: frozenSystem}];
    if (state.compactedDigest) {
      messages.push({role: 'system', content: `【本段早先对话摘要】\n${state.compactedDigest}`});
    }

    // Track prefix tokens up to previous turns (this entire prefix is byte-identical across turns!)
    let cachedPrefixTokens = estimateTokens(frozenSystem) + estimateTokens(state.compactedDigest);
    for (const t of state.turns) {
      const fullTurn = t.tailCapsule ? `${t.content}\n\n${t.tailCapsule}` : t.content;
      messages.push({role: t.role, content: fullTurn});
      cachedPrefixTokens += estimateTokens(fullTurn);
    }

    // Current turn goes strictly at the tail (with volatile mind capsule)
    const finalUser = tailCapsule ? `${currentInput}\n\n[心智脉冲]\n${tailCapsule}` : currentInput;
    messages.push({role: 'user', content: finalUser});

    const totalTokens = cachedPrefixTokens + estimateTokens(finalUser);
    const cacheHitEstimate = state.turns.length > 0 && totalTokens > 0
      ? Math.min(0.97, cachedPrefixTokens / totalTokens)
      : 0;

    state.stats.totalRequests++;
    state.stats.estimatedPrefixTokens = totalTokens;
    state.stats.estimatedCachedTokens = state.turns.length > 0 ? cachedPrefixTokens : 0;
    persist();

    return {
      epochId: state.epochId,
      messages,
      totalTokens,
      cachedPrefixTokens: state.turns.length > 0 ? cachedPrefixTokens : 0,
      cacheHitEstimate,
      needsHalfCompaction: totalTokens >= Math.round(maxBudgetTokens * 0.8),
    };
  }

  // Mid-day 80% watermark safety valve: compact oldest 50% in one batch, keep recent 50% intact
  function compactHalf({summaryText = ''} = {}) {
    if (state.turns.length < 4) return {compacted: false, reason: 'too-few-turns'};
    const cut = Math.floor(state.turns.length / 2);
    const older = state.turns.slice(0, cut);
    const kept = state.turns.slice(cut);
    const digestBlock = summaryText.trim() || summarizeTurnsRuleBased(older);
    state.compactedDigest = [state.compactedDigest, digestBlock].filter(Boolean).join('\n---\n').slice(-2400);
    state.turns = kept;
    state.stats.compactionCount++;
    persist();
    return {compacted: true, droppedTurns: older.length, keptTurns: kept.length, digest: state.compactedDigest};
  }

  // Nightly Auto-Dream / Day Rollover: distill Yesterday Handoff, update Core Pinboard, clear day turns!
  function rolloverNightly({handoffSummary = '', nextCorePinboard, now = Date.now(), tz = timezoneMinutes} = {}) {
    const prevDay = state.epochId;
    const allTurns = [...state.turns];
    const handoff = handoffSummary.trim() || summarizeTurnsRuleBased(allTurns) || state.frozenPrefix.yesterdayHandoff;
    state.frozenPrefix = {
      corePinboard: typeof nextCorePinboard === 'string' ? nextCorePinboard.slice(0, 4000) : state.frozenPrefix.corePinboard,
      yesterdayHandoff: handoff.slice(0, 2000),
      handoffDay: prevDay,
    };
    state.epochId = localDayKey(now, tz);
    state.compactedDigest = '';
    state.turns = [];
    state.stats.lastRolloverAt = now;
    state.stats.compactionCount++;
    persist();
    return {
      rolledOver: true,
      previousEpoch: prevDay,
      newEpoch: state.epochId,
      clearedTurns: allTurns.length,
      yesterdayHandoff: state.frozenPrefix.yesterdayHandoff,
    };
  }

  function summary({maxBudgetTokens = maxTokens} = {}) {
    const used = currentTokens();
    const hitRate = state.stats.estimatedPrefixTokens > 0
      ? Math.round((state.stats.estimatedCachedTokens / state.stats.estimatedPrefixTokens) * 100)
      : 0;
    return {
      epochId: state.epochId,
      turnsCount: state.turns.length,
      usedTokens: used,
      maxTokens: maxBudgetTokens,
      utilizationPercent: Math.min(100, Math.round((used / Math.max(1, maxBudgetTokens)) * 100)),
      estimatedCacheHitPercent: hitRate,
      compactionCount: state.stats.compactionCount,
      hasYesterdayHandoff: Boolean(state.frozenPrefix.yesterdayHandoff),
      yesterdayHandoff: state.frozenPrefix.yesterdayHandoff,
      handoffDay: state.frozenPrefix.handoffDay,
      lastRolloverAt: state.stats.lastRolloverAt,
    };
  }

  return {
    assemblePrompt,
    appendTurn,
    refreshFrozenPrefix,
    compactHalf,
    rolloverNightly,
    currentTokens,
    summary,
  };
}
