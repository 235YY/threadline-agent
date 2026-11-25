// Multi-Format Memory Migration & Import Engine ('threadline-memory-import-v1'):
// Zero dependencies. Lets users safely preview, sanitize, deduplicate, and import
// memories from messy notes, Markdown docs, QQ TXT exports, WeChat CSV/JSON exports,
// or standard threadline-memory-import-v1 JSON/JSONL files into a chosen resident.

import {createHash, randomUUID} from 'node:crypto';
import {guardMemoryWrite, redactSensitiveEgress} from './security-guard.mjs';

export const MEMORY_IMPORT_FORMAT = 'threadline-memory-import-v1';

export const IMPORT_AI_PROMPT = `请把我下面提供的零散记录、旧日记或聊天记录，整理成 Threadline 标准记忆导入协议（threadline-memory-import-v1）的 JSON 格式。
规则：
1. 顶层必须是 {"format":"threadline-memory-import-v1","items":[...]}。
2. 每条 item 必须包含：
   - "type": "note"（长期事实/偏好/经历） | "personal_state"（主观印象/关系认知） | "event"（带时间线的具体对话或事件）
   - "kind": 例如 "preference"、"experience"、"relationship"、"impression"、"chat"
   - "text": 清晰简洁的中文陈述（单条建议 <= 300 字，绝不包含密码、银行卡号或 API Key）
   - "at": 可选，ISO 日期或毫秒时间戳（如 "2026-05-01T20:00:00+08:00"）
   - "tags": 可选字符串数组，例如 ["日常","习惯"]
   - "confidence": 可选 "confident" | "tentative"
3. 丢弃无意义的客套、重复刷屏和敏感隐私信息，只保留真正值得长期记住的内容。
下面是要整理的原始材料：`;

function parseTimeMs(v, fallback = Date.now()) {
  if (Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim().replace(/\//g, '-'));
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

function hashItem(type, text, at) {
  return createHash('sha256').update(`${type}|${text}|${Math.floor(at / 60_000)}`).digest('hex').slice(0, 16);
}

// Parse standard QQ TXT export: "2025-10-12 21:30:15 昵称(123456)\n消息内容"
function parseQqTxt(content, {scene = 'import/qq', ownerNames = []} = {}) {
  const headerRe = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?)(?:\(([^)]+)\)|<([^>]+)>)?\s*$/;
  const lines = String(content ?? '').split(/\r?\n/);
  const items = [];
  let cur = null;
  const ownerSet = new Set(ownerNames.map(s => String(s).trim().toLowerCase()).filter(Boolean));

  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join('\n').trim();
    if (text) {
      items.push({
        type: 'event',
        kind: 'chat',
        at: cur.at,
        scene,
        sender: cur.sender,
        role: ownerSet.has(cur.sender.toLowerCase()) ? 'user' : 'other',
        text,
        tags: ['qq-import'],
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const m = headerRe.exec(line.trim());
    if (m) {
      flush();
      cur = {at: parseTimeMs(m[1]), sender: m[2].trim(), lines: []};
    } else if (cur) {
      if (line.trim() && !line.startsWith('====')) cur.lines.push(line.trim());
    }
  }
  flush();
  return items;
}

// Parse Markdown memory document: "## 偏好" / "## 经历" / "## 印象" + "- item"
function parseMarkdownNotes(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const items = [];
  let currentSection = 'general';
  let currentType = 'note';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h) {
      currentSection = h[1].trim();
      currentType = /印象|关系|主观|认知|state/i.test(currentSection) ? 'personal_state' : 'note';
      continue;
    }
    const b = /^(?:[-*•]|\d+\.)\s+(.+)$/.exec(line);
    const body = b ? b[1].trim() : line;
    if (body.length < 2) continue;
    items.push({
      type: currentType,
      kind: currentSection.slice(0, 32),
      text: body,
      tags: ['md-import', currentSection.slice(0, 24)],
      confidence: 'confident',
    });
  }
  return items;
}

// Parse simple CSV (WeChat PyWxDump / WeFlow / generic: time,sender,content)
function parseSimpleCsv(content, {scene = 'import/wechat'} = {}) {
  const lines = String(content ?? '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const splitCsvLine = line => {
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        cols.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const idxTime = headers.findIndex(h => /time|date|strtime|at/.test(h));
  const idxSender = headers.findIndex(h => /sender|nick|name|from|talker/.test(h));
  const idxText = headers.findIndex(h => /content|text|msg|message|body/.test(h));
  if (idxText === -1) return [];

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const text = (cols[idxText] ?? '').trim();
    if (!text) continue;
    items.push({
      type: 'event',
      kind: 'chat',
      at: idxTime >= 0 ? parseTimeMs(cols[idxTime]) : Date.now(),
      scene,
      sender: idxSender >= 0 ? (cols[idxSender] || 'unknown') : 'unknown',
      text,
      tags: ['csv-import'],
    });
  }
  return items;
}

function parseJsonOrJsonl(content, format) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return [];
  try {
    if (format === 'jsonl') return trimmed.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return parsed?.items ?? parsed?.messages ?? parsed?.notes ?? [parsed];
  } catch {
    throw Object.assign(new Error('INVALID_MEMORY_IMPORT_JSON'), {code:'INVALID_MEMORY_IMPORT_JSON'});
  }
}

export function detectImportFormat(content = '', hint = 'auto') {
  if (hint && hint !== 'auto') return hint;
  const s = String(content ?? '').trim();
  if (!s) return 'markdown';
  if (s.startsWith('{') || s.startsWith('[')) {
    try { JSON.parse(s); return 'json'; }
    catch { return s.startsWith('{') && /}\s*\r?\n\s*{/.test(s) ? 'jsonl' : 'json'; }
  }
  const firstLine = s.split(/\r?\n/)[0] ?? '';
  if (firstLine.includes(',') && /(?:content|text|strcontent|message)/i.test(firstLine)) return 'csv';
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}/m.test(s)) return 'qq-txt';
  return 'markdown';
}

export function previewMemoryImport({
  content = '',
  format = 'auto',
  residentId = 'default',
  scene = 'import/manual',
  trustTier = 'owner',
  ownerNames = [],
  maxItems = 5000,
} = {}) {
  const detected = detectImportFormat(content, format);
  let rawItems = [];
  if (detected === 'json' || detected === 'jsonl') rawItems = parseJsonOrJsonl(content, detected);
  else if (detected === 'qq-txt') rawItems = parseQqTxt(content, {scene, ownerNames});
  else if (detected === 'csv') rawItems = parseSimpleCsv(content, {scene});
  else rawItems = parseMarkdownNotes(content);

  if (!Array.isArray(rawItems)) throw Object.assign(new Error('INVALID_MEMORY_IMPORT_ITEMS'), {code:'INVALID_MEMORY_IMPORT_ITEMS'});
  const batchId = randomUUID();
  const seen = new Set();
  const events = [];
  const notes = [];
  const states = [];
  const blocked = [];
  const warnings = [];
  let redactedCount = 0;
  let duplicateCount = 0;

  if (rawItems.length > maxItems) {
    warnings.push(`输入条数超过单批上限 ${maxItems}，已截断仅预览前 ${maxItems} 条`);
    rawItems = rawItems.slice(0, maxItems);
  }

  for (const [idx, raw] of rawItems.entries()) {
    const type = ['event', 'note', 'personal_state'].includes(raw?.type) ? raw.type : (raw?.sender || raw?.role ? 'event' : 'note');
    const rawText = String(typeof raw === 'string' ? raw : raw?.text ?? raw?.content ?? raw?.body ?? '').trim();
    if (!rawText) continue;

    // 1. Secret DLP redaction
    const dlp = redactSensitiveEgress(rawText);
    if (dlp.redacted) redactedCount++;
    const safeText = dlp.text.slice(0, 1200);

    // 2. Anti-poisoning check
    const guard = guardMemoryWrite({trustTier, targetField: raw?.kind || type, text: rawText});
    if (!guard.allowed) {
      blocked.push({index: idx, reason: guard.reason, preview: safeText.slice(0, 60)});
      continue;
    }

    // 3. Deduplication
    const at = parseTimeMs(raw?.at ?? raw?.timestamp ?? raw?.occurredAt, null);
    const dedupHash = hashItem(type, safeText, at ?? 0);
    if (seen.has(dedupHash)) {
      duplicateCount++;
      continue;
    }
    seen.add(dedupHash);

    const record = {
      id: `${batchId}:${type}:${idx + 1}`,
      type,
      kind: String(raw?.kind ?? (type === 'event' ? 'chat' : 'memory')).slice(0, 40),
      at,
      text: safeText,
      confidence: 'tentative',
      origin: 'imported',
      importBatchId: batchId,
      dedupHash,
    };

    if (type === 'event') events.push(record);
    else if (type === 'personal_state') states.push(record);
    else notes.push(record);
  }

  return {
    format: MEMORY_IMPORT_FORMAT,
    batchId,
    residentId,
    detectedFormat: detected,
    counts: {
      totalParsed: rawItems.length,
      events: events.length,
      notes: notes.length,
      states: states.length,
      duplicatesSkipped: duplicateCount,
      redactedSecrets: redactedCount,
      blocked: blocked.length,
    },
    warnings,
    blocked,
    events,
    notes,
    states,
  };
}

export function memoryImportNotes(preview) {
  return [...preview.notes, ...preview.events, ...preview.states].map(item => {
    const date = item.at ? `，${new Date(item.at).toISOString().slice(0, 10)}` : '';
    const prefix = item.type === 'event' ? `【导入聊天记录${date}】\n`
      : item.type === 'personal_state' ? '【导入的旧印象】\n' : '';
    return {body:prefix + item.text};
  });
}
