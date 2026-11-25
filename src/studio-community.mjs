// Zero-Server Parasitic Community Hub & Privacy-First Selective Share Packs (.tlpack).
// - Exports only explicitly selected fields (persona, skin, widgets, limbic params, hand-picked public notes).
// - ALWAYS strips API keys, secrets, QQ accounts, and never touches the private SQLite memory store.
// - Imports convert cleanly into an approval-guarded proposal so nothing silently overwrites user state.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from './contracts.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';

export const DEFAULT_COMMUNITY_CHANNELS = Object.freeze([
  {
    id: 'github-discussions',
    name: 'GitHub Discussions',
    tag: '插件发布 · 功能许愿 · 长文教程',
    desc: '开源主阵地：发布皮肤/插件/桌宠包、提交 Bug 与新版本投票。',
    url: 'https://github.com/235YY/threadline-agent/discussions',
    actionLabel: '前往讨论区',
  },
  {
    id: 'qq-channel',
    name: 'QQ 频道 / 交流群',
    tag: '晒崽日常 · 新手互助 · 皮肤自取',
    desc: '国内小伙伴最顺手的即时交流地，分版块晒图求助不刷屏。',
    url: '',
    code: '作者可在设置中填入频道号 / 群号',
    actionLabel: '复制频道口令',
  },
  {
    id: 'xiaohongshu',
    name: '小红书话题广场',
    tag: '高颜值换肤 · 聊天实录 · 卡片领养',
    desc: '搜索 #ThreadlineStudio 看大家怎么养崽，保存海报图拖进软件即可导入。',
    url: 'https://www.xiaohongshu.com/search_result?keyword=ThreadlineStudio',
    code: '#ThreadlineStudio',
    actionLabel: '逛小红书话题',
  },
  {
    id: 'bilibili-douyin',
    name: 'B 站 / 抖音视频区',
    tag: '实时数字人 · 桌宠互动 · 教程视频',
    desc: '看会说话的数字人、Cortico 桌宠和保姆级安装演示。',
    url: 'https://search.bilibili.com/all?keyword=Threadline%20Agent',
    code: '#ThreadlineStudio',
    actionLabel: '看视频演示',
  },
  {
    id: 'discord',
    name: 'Discord 国际社区',
    tag: 'Global Geeks · MCP · DSH',
    desc: '面向全球极客与插件开发者的实时频道（可填入邀请链接）。',
    url: '',
    code: '作者可填入 Discord 邀请链接',
    actionLabel: '加入 Discord',
  },
]);

export function buildSelectivePack({
  profile,
  activeResident,
  extensions = [],
  publicNotes = [],
  include = {},
  author = 'Threadline 创作者',
  title = '',
  description = '',
} = {}) {
  ensure(profile && typeof profile === 'object', 'PACK_PROFILE_REQUIRED', 'profile required');
  const pack = {
    format: 'threadline-pack-v1',
    createdAt: Date.now(),
    meta: {
      title: String(title || profile.characterName || '我的 Threadline 分享包').trim().slice(0, 80),
      author: String(author || '匿名创作者').trim().slice(0, 40),
      description: String(description || activeResident?.tagline || '由 Threadline Studio 选择性脱敏导出').trim().slice(0, 240),
    },
    included: {
      persona: include.persona !== false,
      skin: include.skin !== false,
      limbic: Boolean(include.limbic),
      extensions: Boolean(include.extensions),
      notes: Boolean(include.notes),
    },
  };

  if (pack.included.persona) {
    pack.resident = {
      name: profile.characterName || 'Threadline',
      tagline: activeResident?.tagline || '',
      roleMode: activeResident?.roleMode || 'companion',
      identity: profile.identity || '',
      style: profile.style || '',
      reasoning: profile.reasoning || 'low',
      autoDream: profile.autoDream !== false,
    };
  }
  if (pack.included.skin && profile.ui) {
    // Strictly visual fields only; never leaks paths or tokens
    const {skin, theme, layout, accent, autoAccent, bubbleRadius, fontSize, bgBlur, bgOpacity, customCss, petPack} = profile.ui;
    pack.ui = {skin, theme, layout, accent, autoAccent, bubbleRadius, fontSize, bgBlur, bgOpacity, customCss, petPack};
  }
  if (pack.included.limbic && profile.parameters) {
    pack.limbic = {parameters: {...profile.parameters}};
  }
  if (pack.included.extensions) {
    pack.extensions = extensions.filter(e => e.enabled).map(({id, name, slot, kind, title: t, body, targetDate, minutes, css}) => ({
      id, name, slot, kind, title: t, body, targetDate, minutes, css, enabled: true,
    }));
  }
  if (pack.included.notes && Array.isArray(publicNotes) && publicNotes.length) {
    pack.notes = publicNotes.slice(0, 32).map(n => ({
      kind: n.kind || 'interpretation',
      body: String(n.body || '').trim().slice(0, 1000),
    })).filter(n => n.body.length > 0);
  }
  return pack;
}

export function convertPackToPatch(pack) {
  ensure(pack && typeof pack === 'object' && pack.format === 'threadline-pack-v1', 'PACK_INVALID', 'not a valid threadline-pack-v1 bundle');
  const patch = {
    format: 'threadline-patch-v1',
    summary: `导入社区分享包：${pack.meta?.title || '未命名作品'}（作者：${pack.meta?.author || '社区创作者'}）`,
  };
  if (pack.resident) patch.resident = {createNew: false, ...pack.resident};
  if (pack.ui) patch.ui = {...pack.ui};
  if (Array.isArray(pack.extensions) && pack.extensions.length) patch.extension = pack.extensions[0];
  if (Array.isArray(pack.notes) && pack.notes.length) patch.notes = pack.notes;
  return patch;
}

export function createCommunityStore({directory} = {}) {
  const file = join(directory, 'community-channels.json');
  function listChannels() {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch { /* fallback */ }
    }
    return DEFAULT_COMMUNITY_CHANNELS.map(c => ({...c}));
  }
  function saveChannels(channels) {
    ensure(Array.isArray(channels) && channels.length >= 1 && channels.length <= 12, 'CHANNELS_INVALID', 'invalid channels list');
    const clean = channels.map(c => ({
      id: String(c.id || '').slice(0, 40),
      name: String(c.name || '').trim().slice(0, 50),
      tag: String(c.tag || '').trim().slice(0, 80),
      desc: String(c.desc || '').trim().slice(0, 180),
      url: typeof c.url === 'string' && (!c.url.trim() || /^https?:\/\/.+/.test(c.url.trim())) ? c.url.trim().slice(0, 300) : '',
      code: String(c.code || '').trim().slice(0, 120),
      actionLabel: String(c.actionLabel || '打开').trim().slice(0, 24),
    }));
    writeLedgerAtomically(file, clean);
    return clean;
  }
  return {listChannels, saveChannels};
}
