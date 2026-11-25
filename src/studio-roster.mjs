// Multi-Resident Roster, Multi-API Provider Pool, and Per-Resident Agent Workspace Permissions.
// Keeps every digital life in its own isolated directory (`residents/<id>/`) so memories,
// Limbic affect states, personas, and workspaces never leak across characters.
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensure} from './contracts.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const DEFAULT_TOOL_PERMISSIONS = Object.freeze({
  officeRead: true,
  officeWrite: true,
  workspaceRead: false,
  workspaceWrite: false,
  webExplore: false,
  mcpRead: true,
  mcpWrite: false,
  requireApprovalForWrite: true,
});

export const DEFAULT_PROVIDERS = Object.freeze([
  {
    id: 'deepseek-default',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    kind: 'deepseek',
    dailyLimit: 5,
  },
  {
    id: 'ollama-local',
    label: '本地 Ollama（免费离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    kind: 'openai-compatible',
    dailyLimit: 20,
  },
]);

function normalizePermissions(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    officeRead: src.officeRead !== false,
    officeWrite: src.officeWrite !== false,
    workspaceRead: Boolean(src.workspaceRead),
    workspaceWrite: Boolean(src.workspaceWrite),
    webExplore: Boolean(src.webExplore),
    mcpRead: src.mcpRead !== false,
    mcpWrite: Boolean(src.mcpWrite),
    requireApprovalForWrite: src.requireApprovalForWrite !== false,
  };
}

export function normalizeProvider(entry) {
  ensure(entry && typeof entry === 'object', 'PROVIDER_FORMAT', 'invalid provider object');
  const id = String(entry.id || `prov-${randomUUID().slice(0, 8)}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  ensure(SAFE_ID.test(id), 'PROVIDER_ID', 'invalid provider id');
  const label = String(entry.label || id).trim().slice(0, 60) || id;
  const baseUrl = String(entry.baseUrl || '').trim().replace(/\/+$/, '');
  ensure(/^https?:\/\/.+/.test(baseUrl), 'PROVIDER_URL', 'provider baseUrl must start with http(s)://');
  const model = String(entry.model || '').trim().slice(0, 120);
  const kind = baseUrl === 'https://api.deepseek.com' ? 'deepseek' : 'openai-compatible';
  const dailyLimit = Number.isFinite(entry.dailyLimit) ? Math.max(0.1, Math.min(200, entry.dailyLimit)) : 5;
  return {id, label, baseUrl, model, kind, dailyLimit};
}

export function createStudioRoster({directory, defaultName = 'Threadline'} = {}) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = join(directory, 'studio-roster.json');
  const memoryKeys = new Map();
  const pendingApprovals = new Map();

  function load() {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.residents) && parsed.residents.length) {
          return {
            version: 1,
            activeResidentId: parsed.activeResidentId || parsed.residents[0].id,
            copilotProviderId: parsed.copilotProviderId || (parsed.providers?.[0]?.id ?? 'deepseek-default'),
            providers: Array.isArray(parsed.providers) && parsed.providers.length
              ? parsed.providers.map(normalizeProvider)
              : DEFAULT_PROVIDERS.map(p => ({...p})),
            residents: parsed.residents.map(r => ({
              id: r.id,
              name: String(r.name || 'Threadline').slice(0, 60),
              tagline: String(r.tagline || '').slice(0, 120),
              roleMode: r.roleMode === 'agent' ? 'agent' : 'companion',
              providerId: r.providerId || 'deepseek-default',
              workspaceDir: typeof r.workspaceDir === 'string' && (!r.workspaceDir || isAbsolute(r.workspaceDir)) ? r.workspaceDir : '',
              permissions: normalizePermissions(r.permissions),
              avatarDataUrl: typeof r.avatarDataUrl === 'string' ? r.avatarDataUrl : '',
              createdAt: r.createdAt || Date.now(),
            })),
          };
        }
      } catch { /* fall through */ }
    }
    const initial = {
      version: 1,
      activeResidentId: 'primary',
      copilotProviderId: 'deepseek-default',
      providers: DEFAULT_PROVIDERS.map(p => ({...p})),
      residents: [{
        id: 'primary',
        name: defaultName,
        tagline: '陪伴与思考兼备的数字生命',
        roleMode: 'companion',
        providerId: 'deepseek-default',
        workspaceDir: '',
        permissions: {...DEFAULT_TOOL_PERMISSIONS},
        avatarDataUrl: '',
        createdAt: Date.now(),
      }],
    };
    writeLedgerAtomically(file, initial);
    return initial;
  }

  let data = load();
  const persist = () => writeLedgerAtomically(file, data);

  function residentDirectory(id) {
    if (id === 'primary') return directory;
    const dir = join(directory, 'residents', id);
    mkdirSync(dir, {recursive: true, mode: 0o700});
    return dir;
  }

  function snapshot() {
    return {
      activeResidentId: data.activeResidentId,
      copilotProviderId: data.copilotProviderId,
      providers: data.providers.map(p => ({...p, hasKey: Boolean(memoryKeys.get(p.id))})),
      residents: data.residents.map(r => ({...r})),
      pendingApprovals: [...pendingApprovals.values()].filter(a => a.status === 'pending'),
    };
  }

  function setProviderKey(providerId, key) {
    if (!providerId) return;
    const trimmed = String(key || '').trim();
    if (trimmed) memoryKeys.set(providerId, trimmed);
    else memoryKeys.delete(providerId);
  }

  function getProvider(providerId) {
    const p = data.providers.find(x => x.id === providerId) ?? data.providers[0];
    return p ? {...p, apiKey: memoryKeys.get(p.id) || ''} : null;
  }

  function upsertProvider(entry, apiKey) {
    const clean = normalizeProvider(entry);
    const idx = data.providers.findIndex(p => p.id === clean.id);
    if (idx >= 0) data.providers[idx] = clean;
    else data.providers.push(clean);
    if (apiKey !== undefined) setProviderKey(clean.id, apiKey);
    persist();
    return {...clean, hasKey: Boolean(memoryKeys.get(clean.id))};
  }

  function removeProvider(providerId) {
    ensure(data.providers.length > 1, 'PROVIDER_LAST', 'at least one provider must remain');
    data.providers = data.providers.filter(p => p.id !== providerId);
    memoryKeys.delete(providerId);
    const fallback = data.providers[0].id;
    if (data.copilotProviderId === providerId) data.copilotProviderId = fallback;
    for (const r of data.residents) {
      if (r.providerId === providerId) r.providerId = fallback;
    }
    persist();
    return snapshot();
  }

  function createResident({name, tagline = '', roleMode = 'companion', providerId, workspaceDir = '', permissions, avatarDataUrl = ''} = {}) {
    const cleanName = String(name || '').trim().slice(0, 60);
    ensure(cleanName.length > 0, 'RESIDENT_NAME_REQUIRED', 'resident name is required');
    const id = `res-${randomUUID().slice(0, 8)}`;
    const validProvider = data.providers.some(p => p.id === providerId) ? providerId : data.providers[0].id;
    const cleanWs = typeof workspaceDir === 'string' ? workspaceDir.trim() : '';
    ensure(!cleanWs || isAbsolute(cleanWs), 'WORKSPACE_ABSOLUTE_REQUIRED', 'workspaceDir must be an absolute path');
    const item = {
      id,
      name: cleanName,
      tagline: String(tagline || '').trim().slice(0, 120),
      roleMode: roleMode === 'agent' ? 'agent' : 'companion',
      providerId: validProvider,
      workspaceDir: cleanWs,
      permissions: normalizePermissions(permissions),
      avatarDataUrl: typeof avatarDataUrl === 'string' ? avatarDataUrl.slice(0, 900000) : '',
      createdAt: Date.now(),
    };
    residentDirectory(id);
    data.residents.push(item);
    persist();
    return item;
  }

  function updateResident(id, patch = {}) {
    const r = data.residents.find(x => x.id === id);
    ensure(r, 'RESIDENT_NOT_FOUND', `resident not found: ${id}`);
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 60);
      if (n) r.name = n;
    }
    if (patch.tagline !== undefined) r.tagline = String(patch.tagline).trim().slice(0, 120);
    if (patch.roleMode !== undefined) r.roleMode = patch.roleMode === 'agent' ? 'agent' : 'companion';
    if (patch.providerId !== undefined && data.providers.some(p => p.id === patch.providerId)) r.providerId = patch.providerId;
    if (patch.workspaceDir !== undefined) {
      const ws = String(patch.workspaceDir || '').trim();
      ensure(!ws || isAbsolute(ws), 'WORKSPACE_ABSOLUTE_REQUIRED', 'workspaceDir must be an absolute path');
      r.workspaceDir = ws;
    }
    if (patch.permissions !== undefined) r.permissions = normalizePermissions({...r.permissions, ...patch.permissions});
    if (patch.avatarDataUrl !== undefined) r.avatarDataUrl = String(patch.avatarDataUrl || '').slice(0, 900000);
    persist();
    return {...r};
  }

  function setActiveResident(id) {
    ensure(data.residents.some(r => r.id === id), 'RESIDENT_NOT_FOUND', `resident not found: ${id}`);
    data.activeResidentId = id;
    persist();
    return data.residents.find(r => r.id === id);
  }

  function setCopilotProvider(providerId) {
    ensure(data.providers.some(p => p.id === providerId), 'PROVIDER_NOT_FOUND', 'provider not found');
    data.copilotProviderId = providerId;
    persist();
    return data.copilotProviderId;
  }

  function requestApproval({residentId, tool, args, reason}) {
    const id = 'apr-' + randomUUID().slice(0, 8);
    const entry = {id, residentId, tool, args, reason: String(reason || '高危操作需要主人授权'), status: 'pending', createdAt: Date.now()};
    pendingApprovals.set(id, entry);
    return entry;
  }

  function resolveApproval(id, approved) {
    const entry = pendingApprovals.get(id);
    ensure(entry, 'APPROVAL_NOT_FOUND', 'approval not found');
    entry.status = approved ? 'approved' : 'rejected';
    entry.resolvedAt = Date.now();
    return entry;
  }

  return {
    snapshot,
    residentDirectory,
    activeResident: () => data.residents.find(r => r.id === data.activeResidentId) ?? data.residents[0],
    getProvider,
    setProviderKey,
    upsertProvider,
    removeProvider,
    createResident,
    updateResident,
    setActiveResident,
    setCopilotProvider,
    requestApproval,
    resolveApproval,
  };
}
