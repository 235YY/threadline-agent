// DSH-inspired "Create Mode" with strict safety boundaries:
// - Frozen core: DIY widgets/extensions live strictly in isolated `user-extensions/`
// - Declarative extension slots (`topbar-badge`, `room-widget`, `glassbox-card`)
// - Automatic 20-step Time-Machine Snapshots before every mutation
// - Shell-only Factory Reset (NEVER touches subject.sqlite memories, notes, or events)
// - Risk-tier classifier (`low` | `medium` | `high`)
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensure} from './contracts.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ALLOWED_SLOTS = new Set(['topbar-badge', 'room-widget', 'glassbox-card']);
const ALLOWED_KINDS = new Set(['countdown', 'pomodoro', 'note-card', 'css-addon']);
const MAX_SNAPSHOTS = 20;
const FORBIDDEN_PATTERNS = /<\s*script|javascript:|on[a-z]+\s*=|@import\s+url|expression\s*\(/i;

export function sanitizeExtensionSpec(input) {
  ensure(input && typeof input === 'object', 'EXT_FORMAT', 'extension must be an object');
  const id = String(input.id || `ext-${randomUUID().slice(0, 8)}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  ensure(SAFE_ID.test(id), 'EXT_ID', 'invalid extension id');
  const name = String(input.name || id).trim().slice(0, 60) || id;
  const slot = ALLOWED_SLOTS.has(input.slot) ? input.slot : 'room-widget';
  const kind = ALLOWED_KINDS.has(input.kind) ? input.kind : 'note-card';
  const title = String(input.title || name).trim().slice(0, 80);
  const body = String(input.body || '').trim().slice(0, 1200);
  const targetDate = typeof input.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.targetDate.trim()) ? input.targetDate.trim() : '';
  const minutes = Number.isFinite(input.minutes) ? Math.max(1, Math.min(180, Math.round(input.minutes))) : 25;
  const css = typeof input.css === 'string' ? input.css.slice(0, 8000) : '';
  ensure(!FORBIDDEN_PATTERNS.test(body) && !FORBIDDEN_PATTERNS.test(css), 'EXT_UNSAFE_CONTENT', 'scripts or unsafe inline handlers are blocked by sandbox');
  return {
    id,
    name,
    slot,
    kind,
    title,
    body,
    targetDate,
    minutes,
    css,
    enabled: input.enabled !== false,
    createdAt: input.createdAt || Date.now(),
  };
}

export function classifyPatchRisk(patch) {
  if (!patch || typeof patch !== 'object') return {level: 'low', label: '低风险', reason: '无破坏性修改'};
  if (patch.mcp || patch.resident?.permissions?.workspaceWrite || patch.resident?.permissions?.mcpWrite) {
    return {level: 'high', label: '高风险（涉及外部插件或写入权限）', reason: '请仔细核对工具来源与写入权限后再允许'};
  }
  if (patch.provider || patch.gateway || patch.resident?.daily !== undefined || patch.resident?.createNew) {
    return {level: 'medium', label: '中风险（涉及接口、预算或新角色）', reason: '将变更网络接口、预算红线或角色档案'};
  }
  return {level: 'low', label: '低风险（仅外观、人设或隔离扩展）', reason: '所有改动均有自动快照，随时可一键回退'};
}

export function createStudioSandbox({directory} = {}) {
  const extDir = join(directory, 'user-extensions');
  const snapDir = join(directory, 'snapshots');
  mkdirSync(extDir, {recursive: true, mode: 0o700});
  mkdirSync(snapDir, {recursive: true, mode: 0o700});

  function listExtensions() {
    if (!existsSync(extDir)) return [];
    const out = [];
    for (const file of readdirSync(extDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(extDir, file), 'utf8'));
        out.push(sanitizeExtensionSpec(parsed));
      } catch { /* ignore malformed */ }
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function saveExtension(spec) {
    const clean = sanitizeExtensionSpec(spec);
    writeLedgerAtomically(join(extDir, `${clean.id}.json`), clean);
    return clean;
  }

  function toggleExtension(id, enabled) {
    ensure(SAFE_ID.test(String(id || '')), 'EXT_ID', 'invalid extension id');
    const p = join(extDir, `${id}.json`);
    ensure(existsSync(p), 'EXT_NOT_FOUND', 'extension not found');
    const current = sanitizeExtensionSpec(JSON.parse(readFileSync(p, 'utf8')));
    current.enabled = Boolean(enabled);
    writeLedgerAtomically(p, current);
    return current;
  }

  function deleteExtension(id) {
    ensure(SAFE_ID.test(String(id || '')), 'EXT_ID', 'invalid extension id');
    rmSync(join(extDir, `${id}.json`), {force: true});
    return {ok: true, id};
  }

  function clearAllExtensions() {
    if (!existsSync(extDir)) return;
    for (const file of readdirSync(extDir)) {
      if (file.endsWith('.json')) rmSync(join(extDir, file), {force: true});
    }
  }

  function takeSnapshot({label = '自动快照', ui, gateway, mcp}) {
    const id = `snap-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const payload = {
      id,
      label: String(label || '自动快照').slice(0, 80),
      createdAt: Date.now(),
      ui: ui ? JSON.parse(JSON.stringify(ui)) : null,
      gateway: gateway ? JSON.parse(JSON.stringify(gateway)) : null,
      mcp: mcp ? JSON.parse(JSON.stringify(mcp)) : null,
      extensions: listExtensions(),
    };
    writeLedgerAtomically(join(snapDir, `${id}.json`), payload);
    // Keep only latest MAX_SNAPSHOTS
    const files = readdirSync(snapDir).filter(f => f.endsWith('.json')).sort();
    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      rmSync(join(snapDir, oldest), {force: true});
    }
    return {id: payload.id, label: payload.label, createdAt: payload.createdAt, extensionCount: payload.extensions.length};
  }

  function listSnapshots() {
    if (!existsSync(snapDir)) return [];
    const out = [];
    for (const file of readdirSync(snapDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(snapDir, file), 'utf8'));
        out.push({id: s.id, label: s.label, createdAt: s.createdAt, extensionCount: (s.extensions || []).length});
      } catch { /* ignore */ }
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function loadSnapshot(id) {
    ensure(SAFE_ID.test(String(id || '')), 'SNAPSHOT_ID', 'invalid snapshot id');
    const p = join(snapDir, `${id}.json`);
    ensure(existsSync(p), 'SNAPSHOT_NOT_FOUND', 'snapshot not found');
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  function restoreExtensionsFrom(extensions = []) {
    clearAllExtensions();
    for (const ext of extensions) {
      try { saveExtension(ext); } catch { /* ignore */ }
    }
  }

  function combinedExtensionCss() {
    return listExtensions()
      .filter(e => e.enabled && e.css)
      .map(e => `/* ext:${e.id} */\n${e.css}`)
      .join('\n\n');
  }

  return {
    listExtensions,
    saveExtension,
    toggleExtension,
    deleteExtension,
    clearAllExtensions,
    takeSnapshot,
    listSnapshots,
    loadSnapshot,
    restoreExtensionsFrom,
    combinedExtensionCss,
  };
}
