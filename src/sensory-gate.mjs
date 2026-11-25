// Sensory & Action Privacy Gate ('sensory-gate-v1'):
// Zero-dependency local privacy firewall for ambient desktop/mobile signals
// (ActivityWatch, Screenpipe MCP, weather, coarse location, wearables, media, games)
// and high-risk computer-control authorization.
//
// Core invariants:
// 1. Default level is L0 (off); L1 (ambient presence only) is recommended for daily companionship.
// 2. Hard-blocked sensitive apps/domains (banks, password managers, incognito, private auth)
//    are dropped at ingress and NEVER reach prompts or disk.
// 3. Raw GPS coordinates are rejected/coarsened; ephemeral signals stay in RAM with TTL only.
// 4. Per-resident ACL + per-client scoped tokens + one-click Curtain Mode (instant cutoff) + audit ring.

import {existsSync, readFileSync} from 'node:fs';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {writeLedgerAtomically} from './ledger-io.mjs';

export const SENSORY_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
const LEVEL_RANK = Object.freeze({L0: 0, L1: 1, L2: 2, L3: 3});

export const SIGNAL_MIN_LEVEL = Object.freeze({
  activity: 'L1',
  weather: 'L1',
  location: 'L1',
  wearable: 'L1',
  media: 'L1',
  game: 'L1',
  screen_peek: 'L2',
  camera_peek: 'L2',
  live_screen: 'L3',
  live_call: 'L3',
});

export const HARD_BLOCK_PATTERNS = Object.freeze([
  '1password', 'bitwarden', 'keepass', 'lastpass', 'keychain', 'credential',
  'alipay', 'wechatpay', 'paypal', 'stripe', 'icbc', 'cmbchina', 'ccb', 'boc', 'bank',
  'incognito', 'inprivate', 'private browsing', '无痕', '隐私窗口',
  '密码', '网银', '支付', '付款', '登录验证', 'otp', '2fa', 'authenticator',
]);

const RAW_COORD_RE = /(?:\b-?\d{1,3}\.\d{3,}\s*[,，;；/\s]+\s*-?\d{1,3}\.\d{3,}\b)|(?:\b(?:latitude|longitude|lat|lng|lon)|经度|纬度)\s*[:=：]?\s*-?\d{1,3}\.\d+/iu;
const safeId = id => typeof id==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)&&!['prototype','constructor'].includes(id);
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const CLIENT_SCOPES = ['chat', 'sensory:push', 'sensory:read'];

function cleanText(v, max = 180) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeLevel(level, fallback = 'L0') {
  return SENSORY_LEVELS.includes(level) ? level : fallback;
}

export function createSensoryGate({stateFile = null, maxAudit = 100, clock = Date.now} = {}) {
  const defaultPolicy = {
    format: 'threadline-sensory-policy-v1',
    globalLevel: 'L0',
    curtain: false,
    filterMode: 'blacklist', // 'blacklist' | 'whitelist'
    customBlacklist: [],
    whitelistApps: [],
    residentLevels: {}, // residentId -> 'L0'|'L1'|'L2'|'L3'
    computerControl: {
      enabled: false,
      requireApproval: true,
      allowedApps: [],
      emergencyStopped: false,
    },
    clients: {}, // clientId -> { label, token, scopes: [...] }
  };

  maxAudit = Number.isSafeInteger(maxAudit) ? Math.max(0,Math.min(200,maxAudit)) : 100;
  let policy = structuredClone(defaultPolicy);
  if (stateFile && existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved && saved.format === 'threadline-sensory-policy-v1') {
        policy = {
          ...structuredClone(defaultPolicy),
          ...saved,
          globalLevel: normalizeLevel(saved.globalLevel, 'L0'),
          curtain: Boolean(saved.curtain),
          filterMode: saved.filterMode === 'whitelist' ? 'whitelist' : 'blacklist',
          customBlacklist: Array.isArray(saved.customBlacklist) ? saved.customBlacklist.map(x => cleanText(x, 60)).filter(Boolean).slice(0, 64) : [],
          whitelistApps: Array.isArray(saved.whitelistApps) ? saved.whitelistApps.map(x => cleanText(x, 60)).filter(Boolean).slice(0, 64) : [],
          residentLevels: saved.residentLevels && typeof saved.residentLevels === 'object' ? saved.residentLevels : {},
          computerControl: {
            ...defaultPolicy.computerControl,
            ...(saved.computerControl ?? {}),
            enabled: Boolean(saved.computerControl?.enabled),
            requireApproval: saved.computerControl?.requireApproval !== false,
            emergencyStopped: Boolean(saved.computerControl?.emergencyStopped),
          },
          clients: Object.fromEntries(Object.entries(saved.clients??{}).filter(([id,c])=>safeId(id)&&safeId(c?.residentId)&&/^[a-f0-9]{64}$/.test(c?.tokenHash)&&Array.isArray(c.scopes))),
        };
      }
    } catch { /* ignore corrupt file, stay fail-closed L0 */ }
  }

  // Ephemeral RAM-only live signal store: key -> { source, kind, summary, app, at, expiresAt, ephemeral }
  const liveSignals = new Map();
  // Ring buffer of privacy audit events (never stores blocked raw content)
  const audit = [];

  function savePolicy() {
    if (!stateFile) return;
    writeLedgerAtomically(stateFile,policy);
  }

  function recordAudit(entry) {
    audit.push({at: clock(), ...entry});
    while (audit.length > maxAudit) audit.shift();
  }

  function pruneExpired() {
    const now = clock();
    for (const [k, v] of liveSignals.entries()) {
      if (v.expiresAt <= now) liveSignals.delete(k);
    }
  }

  function effectiveLevel(residentId = null) {
    if (policy.curtain) return 'L0';
    const g = LEVEL_RANK[policy.globalLevel] ?? 0;
    if (residentId && Object.hasOwn(policy.residentLevels, residentId)) {
      const r = LEVEL_RANK[normalizeLevel(policy.residentLevels[residentId], 'L0')] ?? 0;
      return SENSORY_LEVELS[Math.min(g, r)];
    }
    return policy.globalLevel;
  }

  function matchesSensitive(app, domain, summary) {
    const hay = `${app ?? ''} ${domain ?? ''} ${summary ?? ''}`.toLowerCase();
    for (const pat of HARD_BLOCK_PATTERNS) {
      if (hay.includes(pat)) return `hard-blocked:${pat}`;
    }
    for (const pat of policy.customBlacklist) {
      if (pat && hay.includes(pat.toLowerCase())) return `blacklist:${pat}`;
    }
    return null;
  }

  function ingestSignal(input = {}) {
    if (!input || typeof input!=='object' || Array.isArray(input)) return {accepted:false,reason:'INVALID_SIGNAL'};
    const {
    source = 'external',
    kind = 'activity',
    summary = '',
    app = '',
    domain = '',
    residentId = null,
    ttlMs = 15 * 60 * 1000,
    } = input;
    pruneExpired();
    if (!Object.hasOwn(SIGNAL_MIN_LEVEL,kind)||[source, summary, app, domain].some(x=>typeof x!=='string'||x.length>4096)||residentId!==null&&!safeId(residentId)) {
      return {accepted:false,reason:'INVALID_SIGNAL'};
    }
    const safeSource = safeId(source) ? source : 'external';
    const safeKind = kind;
    const safeApp = cleanText(app, 64);
    const safeDomain = cleanText(domain, 96);
    const safeSummary = cleanText(summary, 200);

    if (policy.curtain) {
      recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'curtain', reason: 'curtain-active'});
      return {accepted: false, reason: 'CURTAIN_ACTIVE'};
    }

    const level = effectiveLevel(residentId);
    const minLevel = SIGNAL_MIN_LEVEL[safeKind] ?? 'L1';
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
      recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'blocked', reason: `requires-${minLevel}-current-${level}`});
      return {accepted: false, reason: 'LEVEL_TOO_LOW', required: minLevel, current: level};
    }

    // Hard-block sensitive apps, domains, password/banking hints
    const sensitiveHit = input.private===true||input.incognito===true||input.passwordField===true ? 'sensitive-context' : matchesSensitive(app,domain,summary);
    if (sensitiveHit) {
      recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'blocked', reason: sensitiveHit});
      return {accepted: false, reason: 'SENSITIVE_BLOCKED'};
    }

    // Whitelist mode check when app/domain is supplied
    if (policy.filterMode === 'whitelist') {
      const target = [safeApp.toLowerCase(),safeDomain.toLowerCase()];
      const ok = policy.whitelistApps.some(w => w && target.includes(w.toLowerCase()));
      if (!ok) {
        recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'blocked', reason: 'not-in-whitelist'});
        return {accepted: false, reason: 'NOT_IN_WHITELIST'};
      }
    }

    // Reject raw GPS coordinates on location signals (require coarse place label only)
    if ([app,domain,summary].some(x=>RAW_COORD_RE.test(x))||Object.keys(input).some(k=>/^(?:lat|lon|lng|latitude|longitude|coordinates|gps)$/i.test(k))) {
      recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'blocked', reason: 'raw-coordinates-rejected'});
      return {accepted: false, reason: 'RAW_COORDINATES_NOT_ALLOWED'};
    }

    const boundedTtl = Math.max(10_000, Math.min(4 * 3600 * 1000, Number(ttlMs) || 15 * 60 * 1000));
    const now = clock();
    const key = `${residentId ?? '*'}:${safeKind}:${safeSource}`;
    liveSignals.delete(key);
    liveSignals.set(key, {
      source: safeSource,
      kind: safeKind,
      app: safeApp || null,
      summary: safeSummary,
      residentId: residentId ?? null,
      ephemeral: true,
      at: now,
      expiresAt: now + boundedTtl,
    });
    while(liveSignals.size>64)liveSignals.delete(liveSignals.keys().next().value);
    recordAudit({source: safeSource, kind: safeKind, residentId, decision: 'allowed', reason: level});
    return {accepted: true, key, level, expiresAt: now + boundedTtl};
  }

  function setCurtain(active) {
    policy.curtain = Boolean(active);
    if (policy.curtain) {
      liveSignals.clear();
      policy.computerControl.emergencyStopped = true;
    }
    savePolicy();
    recordAudit({source: 'owner', kind: 'curtain', residentId: null, decision: policy.curtain ? 'curtain' : 'allowed', reason: policy.curtain ? 'curtain-closed' : 'curtain-opened'});
    return status();
  }

  function updatePolicy(patch = {}) {
    if (patch.globalLevel !== undefined) policy.globalLevel = normalizeLevel(patch.globalLevel, policy.globalLevel);
    liveSignals.clear();
    if (patch.filterMode === 'blacklist' || patch.filterMode === 'whitelist') policy.filterMode = patch.filterMode;
    if (Array.isArray(patch.customBlacklist)) {
      policy.customBlacklist = patch.customBlacklist.map(x => cleanText(x, 60)).filter(Boolean).slice(0, 64);
    }
    if (Array.isArray(patch.whitelistApps)) {
      policy.whitelistApps = patch.whitelistApps.map(x => cleanText(x, 60)).filter(Boolean).slice(0, 64);
    }
    if (patch.residentLevels && typeof patch.residentLevels === 'object') {
      for (const [rid, lvl] of Object.entries(patch.residentLevels)) {
        if (!safeId(rid)) continue;
        if (lvl === null) delete policy.residentLevels[rid];
        else policy.residentLevels[rid] = normalizeLevel(lvl, 'L0');
      }
    }
    if (patch.computerControl && typeof patch.computerControl === 'object') {
      if (patch.computerControl.enabled !== undefined) policy.computerControl.enabled = Boolean(patch.computerControl.enabled);
      if (patch.computerControl.requireApproval !== undefined) policy.computerControl.requireApproval = patch.computerControl.requireApproval !== false;
      if (Array.isArray(patch.computerControl.allowedApps)) {
        policy.computerControl.allowedApps = patch.computerControl.allowedApps.map(x => cleanText(x, 60)).filter(Boolean).slice(0, 32);
      }
      if (patch.computerControl.emergencyStopped !== undefined) {
        policy.computerControl.emergencyStopped = Boolean(patch.computerControl.emergencyStopped);
      }
    }
    if (patch.curtain !== undefined) return setCurtain(patch.curtain);
    savePolicy();
    return status();
  }

  function authorizeComputerAction({app = '', action = '', approved = false, residentId = null} = {}) {
    const cc = policy.computerControl;
    if (policy.curtain || cc.emergencyStopped || !cc.enabled) {
      recordAudit({source: 'computer', kind: 'computer_action', residentId, decision: 'blocked', reason: 'computer-control-disabled'});
      return {allowed: false, reason: 'COMPUTER_CONTROL_DISABLED'};
    }
    const safeApp = cleanText(app, 64);
    if (cc.allowedApps.length > 0) {
      const ok = safeApp&&cc.allowedApps.some(a => safeApp.toLowerCase()===a.toLowerCase());
      if (!ok) {
        recordAudit({source: 'computer', kind: 'computer_action', residentId, decision: 'blocked', reason: 'app-not-authorized'});
        return {allowed: false, reason: 'APP_NOT_AUTHORIZED'};
      }
    }
    if (matchesSensitive(safeApp, '', action)) {
      recordAudit({source: 'computer', kind: 'computer_action', residentId, decision: 'blocked', reason: 'sensitive-target'});
      return {allowed: false, reason: 'SENSITIVE_TARGET_BLOCKED'};
    }
    if (cc.requireApproval && !approved) {
      return {allowed: false, needsApproval: true, reason: 'APPROVAL_REQUIRED'};
    }
    recordAudit({source: 'computer', kind: 'computer_action', residentId, decision: 'allowed', reason: safeApp || 'approved'});
    return {allowed: true};
  }

  function issueClientToken({clientId, residentId, label = 'External Client', scopes = ['sensory:push']} = {}) {
    const id = clientId??`cli_${randomBytes(8).toString('hex')}`;
    if(!safeId(id)||!safeId(residentId)||!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!CLIENT_SCOPES.includes(s))) throw Object.assign(Error('invalid client grant'),{code:'INVALID_CLIENT_GRANT'});
    if(!Object.hasOwn(policy.clients,id)&&Object.keys(policy.clients).length>=64) throw Object.assign(Error('too many clients'),{code:'CLIENT_LIMIT'});
    for(const [key,signal] of liveSignals) if(signal.source===id)liveSignals.delete(key);
    const token = `tls_${randomBytes(24).toString('hex')}`;
    policy.clients[id] = {label:cleanText(label,60),tokenHash:tokenHash(token),residentId,scopes:[...new Set(scopes)]};
    savePolicy();
    return {clientId:id,label:policy.clients[id].label,token,residentId,scopes:[...policy.clients[id].scopes]};
  }

  function revokeClient(id) {
    if (!safeId(id)||!Object.hasOwn(policy.clients,id)) return {ok:false};
    delete policy.clients[id];
    for (const [key,signal] of liveSignals) if(signal.source===id) liveSignals.delete(key);
    savePolicy();
    return {ok:true};
  }

  function verifyClientToken(token, requiredScope) {
    if (typeof token !== 'string' || !token) return {ok: false, reason: 'MISSING_TOKEN'};
    const bufA = Buffer.from(tokenHash(token),'hex');
    for (const [id, entry] of Object.entries(policy.clients)) {
      const bufB = Buffer.from(entry.tokenHash,'hex');
      if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
        if (requiredScope && !entry.scopes.includes(requiredScope)) {
          return {ok: false, clientId: id, reason: 'INSUFFICIENT_SCOPE'};
        }
        return {ok:true,clientId:id,residentId:entry.residentId,scopes:[...entry.scopes]};
      }
    }
    return {ok: false, reason: 'INVALID_TOKEN'};
  }

  function activeSignals(residentId = null) {
    pruneExpired();
    const level = LEVEL_RANK[effectiveLevel(residentId)];
    if (level === 0) return [];
    const out = [];
    for (const sig of liveSignals.values()) {
      if (sig.residentId!==null&&sig.residentId!==residentId||level<LEVEL_RANK[SIGNAL_MIN_LEVEL[sig.kind]]) continue;
      out.push({...sig});
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 8);
  }

  function buildSensoryPrompt(residentId = null) {
    const list = activeSignals(residentId);
    if (!list.length) return '';
    const labels = {
      activity: '电脑活动', weather: '天气', location: '位置',
      wearable: '体征', media: '正在看', game: '游戏',
      screen_peek: '屏幕一眼', camera_peek: '镜头一眼',
      live_screen: '共屏', live_call: '通话',
    };
    const lines = list.map(s => `- [${labels[s.kind] ?? s.kind}] ${s.summary || s.app || ''}`.trim());
    return `[此刻环境感知（瞬时参考，勿泄露敏感隐私）]\n${lines.join('\n')}`;
  }

  function status(residentId = null) {
    pruneExpired();
    return {
      format: 'threadline-sensory-status-v1',
      globalLevel: policy.globalLevel,
      effectiveLevel: effectiveLevel(residentId),
      curtain: policy.curtain,
      filterMode: policy.filterMode,
      customBlacklist: [...policy.customBlacklist],
      whitelistApps: [...policy.whitelistApps],
      residentLevels: {...policy.residentLevels},
      computerControl: {...policy.computerControl},
      activeSignals: activeSignals(residentId),
      clientCount: Object.keys(policy.clients).length,
      clients: Object.entries(policy.clients).map(([id,{label,residentId,scopes}])=>({id,label,residentId,scopes:[...scopes]})),
      recentAudit: audit.slice(-20).reverse(),
    };
  }

  return {
    ingestSignal,
    setCurtain,
    updatePolicy,
    authorizeComputerAction,
    issueClientToken,
    verifyClientToken,
    revokeClient,
    activeSignals,
    buildSensoryPrompt,
    status,
    effectiveLevel,
  };
}
