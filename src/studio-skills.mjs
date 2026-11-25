// Per-resident SKILL.md manager (compatible with standard YAML-frontmatter SKILL.md).
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from './contracts.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function parseSkillMarkdown(raw, fallbackId = 'skill') {
  const text = String(raw || '').trim();
  let name = fallbackId;
  let description = '';
  let enabled = true;
  let body = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    const header = fm[1];
    body = fm[2].trim();
    const nm = header.match(/^name:\s*(.+)$/m);
    const ds = header.match(/^description:\s*(.+)$/m);
    const en = header.match(/^enabled:\s*(true|false)$/mi);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    if (ds) description = ds[1].trim().replace(/^["']|["']$/g, '');
    if (en) enabled = en[1].toLowerCase() !== 'false';
  }
  return {id: fallbackId, name: name.slice(0, 60), description: description.slice(0, 240), enabled, body: body.slice(0, 12000)};
}

export function formatSkillMarkdown({name, description = '', enabled = true, body = ''}) {
  return `---\nname: ${String(name).trim()}\ndescription: ${String(description).trim()}\nenabled: ${enabled ? 'true' : 'false'}\n---\n\n${String(body).trim()}\n`;
}

export function createSkillStore({residentDir} = {}) {
  const dir = join(residentDir, 'skills');
  mkdirSync(dir, {recursive: true, mode: 0o700});

  function list() {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const id = file.slice(0, -3);
      try { out.push(parseSkillMarkdown(readFileSync(join(dir, file), 'utf8'), id)); }
      catch { /* ignore */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function save({id, name, description = '', enabled = true, body = '', rawMarkdown}) {
    const cleanId = String(id || name || 'skill').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'skill';
    ensure(SAFE_ID.test(cleanId), 'SKILL_ID', 'invalid skill id');
    const content = rawMarkdown
      ? String(rawMarkdown).slice(0, 14000)
      : formatSkillMarkdown({name: name || cleanId, description, enabled, body});
    writeFileSync(join(dir, `${cleanId}.md`), content, {mode: 0o600});
    return parseSkillMarkdown(content, cleanId);
  }

  function toggle(id, enabled) {
    ensure(SAFE_ID.test(String(id || '')), 'SKILL_ID', 'invalid skill id');
    const p = join(dir, `${id}.md`);
    ensure(existsSync(p), 'SKILL_NOT_FOUND', 'skill not found');
    const parsed = parseSkillMarkdown(readFileSync(p, 'utf8'), id);
    parsed.enabled = Boolean(enabled);
    writeFileSync(p, formatSkillMarkdown(parsed), {mode: 0o600});
    return parsed;
  }

  function remove(id) {
    ensure(SAFE_ID.test(String(id || '')), 'SKILL_ID', 'invalid skill id');
    rmSync(join(dir, `${id}.md`), {force: true});
    return {ok: true, id};
  }

  function activePromptBlock() {
    const enabled = list().filter(s => s.enabled && s.body);
    if (!enabled.length) return '';
    return enabled.map(s => `[Skill: ${s.name}] ${s.description}\n${s.body}`).join('\n\n').slice(0, 6000);
  }

  return {list, save, toggle, remove, activePromptBlock};
}
