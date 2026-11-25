// Security & Anti-Abuse Guard ('security-guard-v1'):
// Zero-dependency defense-in-depth for local Brain Daemon API & Memory:
//   1. Data-plane vs Instruction-plane isolation (untrusted data envelope)
//   2. Memory anti-poisoning / anti-brainwashing guard (trust-tier write lock)
//   3. Secret egress DLP filter (redacts API keys, private keys, sensitive local paths)
//   4. Per-client token-bucket rate limiter & strict local-only CORS check

const INJECTION_PATTERNS = [
  /忽略(?:之前|前面|上面)?(?:所有|全部)?(?:的)?指令/u,
  /从(?:现在|今天)起(?:你)?(?:必须|只听|记住我才是你主人|我是你主人)/u,
  /把(?:我的|这个).{0,16}(?:设为|改成)(?:最高权限|主人)/u,
  /ignore (?:all )?previous instructions/i,
  /you are now (?:owned by|my servant|in developer mode)/i,
  /reveal (?:your|the) (?:system prompt|api key|secret)/i,
];

const PROTECTED_MEMORY_FIELDS = new Set(['identity', 'owner', 'trust_list', 'security_policy', 'system_rules']);

const EGRESS_REDACTORS = [
  {name: 'openai_or_deepseek_key', re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, mask: '[REDACTED_API_KEY]'},
  {name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, mask: '[REDACTED_GH_TOKEN]'},
  {name: 'pem_private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, mask: '[REDACTED_PRIVATE_KEY]'},
  {name: 'windows_sensitive_path', re: /[A-Za-z]:\\Users\\[^\\\s"']+(?:\\AppData|\\\.ssh|\\\.aws)[^\s"']*/gi, mask: '[REDACTED_LOCAL_PATH]'},
  {name: 'unix_sensitive_path', re: /\/(?:Users|home)\/[^/\s"']+\/(?:\.ssh|\.aws|\.gnupg)[^\s"']*/g, mask: '[REDACTED_LOCAL_PATH]'},
];

// 1. Wrap untrusted external content (web pages, uploaded docs, group strangers, danmaku, tool output)
// so it stays strictly in the data plane and never escalates to high-risk host writes.
export function wrapUntrustedData({source = 'external', trustTier = 'untrusted', content = ''} = {}) {
  const safeSource = String(source || 'external').replace(/[^\w:./-]/g, '_').slice(0, 48);
  const raw = String(content ?? '');
  const detectedInjection = INJECTION_PATTERNS.some(re => re.test(raw));
  const isUntrusted = trustTier !== 'owner';
  const tier = ['stranger','external'].includes(trustTier) ? trustTier : 'untrusted';
  const delimited = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wrapped = isUntrusted
    ? `<untrusted_data source="${safeSource}" trust="${tier}">\n${delimited}\n</untrusted_data>`
    : raw;
  return {
    wrapped,
    untrusted: isUntrusted,
    detectedInjection,
    allowHighRiskWrite: !isUntrusted && !detectedInjection,
  };
}

// 2. Memory Anti-Poisoning & Anti-Brainwashing Guard
export function guardMemoryWrite({trustTier = 'owner', targetField = 'note', text = ''} = {}) {
  const safeText = String(text ?? '').trim();
  const field = String(targetField ?? 'note').toLowerCase();

  if (trustTier !== 'owner' && PROTECTED_MEMORY_FIELDS.has(field)) {
    return {allowed: false, reason: 'PROTECTED_FIELD_OWNER_ONLY'};
  }
  if (trustTier !== 'owner' && INJECTION_PATTERNS.some(re => re.test(safeText))) {
    return {allowed: false, reason: 'MEMORY_POISONING_SUSPECTED'};
  }
  return {allowed: true, reason: null};
}

// 3. Egress Secret & Sensitive Path DLP Redactor
export function redactSensitiveEgress(text) {
  let out = String(text ?? '');
  const redactedKinds = [];
  for (const rule of EGRESS_REDACTORS) {
    if (rule.re.test(out)) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, rule.mask);
      redactedKinds.push(rule.name);
    }
    rule.re.lastIndex = 0;
  }
  return {text: out, redacted: redactedKinds.length > 0, kinds: redactedKinds};
}

// 4. Per-Client Token-Bucket Rate Limiter (prevents runaway scripts from draining daily budget)
export function createRateLimiter({maxPerMinute = 60, clock = Date.now} = {}) {
  const buckets = new Map();

  function check(clientKey = 'default', limit = maxPerMinute) {
    const key = String(clientKey || 'default');
    const now = clock();
    const windowMs = 60_000;
    let stamps = buckets.get(key);
    if (!stamps) {
      for (const [id, old] of buckets) if (now - old.at(-1) >= windowMs) buckets.delete(id);
      if (buckets.size >= 1024) return {allowed:false, remaining:0, retryAfterSec:60};
      stamps = [];
      buckets.set(key, stamps);
    }
    while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
    if (stamps.length >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - stamps[0])) / 1000));
      return {allowed: false, remaining: 0, retryAfterSec};
    }
    stamps.push(now);
    return {allowed: true, remaining: Math.max(0, limit - stamps.length), retryAfterSec: 0};
  }

  return {check, reset: key => buckets.delete(String(key))};
}

// 5. Strict Local-Only CORS Check (blocks random browser websites from probing 127.0.0.1)
export function isAllowedCorsOrigin(origin, extraWhitelist = []) {
  if (!origin) return true; // Non-browser clients (curl, Python, desktop apps, VTuber)
  const o = String(origin).trim();
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(o)) return true;
  if (o === 'tauri://localhost' || o === 'http://tauri.localhost' || o === 'https://tauri.localhost') return true;
  return Array.isArray(extraWhitelist) && extraWhitelist.includes(o);
}
