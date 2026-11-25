// Multi-Resident Team Collaboration, Shared Workspace, and Mindless Sub-Agent Runner.
// - Allows residents to exchange messages & share files in `_shared_workspace/`.
// - Allows spawning lightweight mindless Sub-Agents (zero Limbic/apperception overhead,
//   append-only cache-friendly prompts) for heavy tasks.
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensure} from './contracts.mjs';
import {writeLedgerAtomically} from './ledger-io.mjs';

export function createTeamHub({directory, fetchImpl = fetch} = {}) {
  const sharedDir = join(directory, '_shared_workspace');
  const busFile = join(directory, 'team-bus.json');
  mkdirSync(sharedDir, {recursive: true, mode: 0o700});

  function loadBus() {
    if (existsSync(busFile)) {
      try {
        const d = JSON.parse(readFileSync(busFile, 'utf8'));
        if (d && Array.isArray(d.messages)) return d;
      } catch { /* fallback */ }
    }
    return {teamEnabled: false, messages: [], subAgentRuns: []};
  }

  let bus = loadBus();
  const persist = () => writeLedgerAtomically(busFile, bus);

  function listSharedFiles() {
    if (!existsSync(sharedDir)) return [];
    return readdirSync(sharedDir).slice(0, 40).map(name => {
      const p = join(sharedDir, name);
      try {
        const st = statSync(p);
        return {name, size: st.size, isDir: st.isDirectory(), mtimeMs: st.mtimeMs};
      } catch { return null; }
    }).filter(Boolean);
  }

  function writeSharedFile({name, content}) {
    ensure(bus.teamEnabled, 'TEAM_DISABLED', 'enable the shared team first');
    const clean = basename(String(name || 'shared-note.txt').replace(/[\\/:*?"<>|]/g, '_')).slice(0, 80);
    ensure(clean.length > 0, 'SHARED_FILE_NAME', 'invalid file name');
    writeFileSync(join(sharedDir, clean), String(content ?? '').slice(0, 200000), {mode: 0o600});
    return {ok: true, name: clean, files: listSharedFiles()};
  }

  function setTeamEnabled(enabled) {
    bus.teamEnabled = Boolean(enabled);
    persist();
    return state();
  }

  function postTeamMessage({fromId, fromName, toId = 'all', text, attachmentName = ''}) {
    ensure(bus.teamEnabled, 'TEAM_DISABLED', 'enable the shared team first');
    const body = String(text || '').trim().slice(0, 2000);
    ensure(body.length > 0, 'TEAM_MSG_EMPTY', 'message required');
    const msg = {
      id: 'tm-' + randomUUID().slice(0, 8),
      fromId, fromName: String(fromName || fromId).slice(0, 50),
      toId, text: body, attachmentName: String(attachmentName || '').slice(0, 80),
      ts: Date.now(),
    };
    bus.messages.push(msg);
    if (bus.messages.length > 80) bus.messages = bus.messages.slice(-80);
    persist();
    return msg;
  }

  async function runMindlessSubAgent({role = '通用执行子 Agent', task, provider}) {
    ensure(bus.teamEnabled, 'TEAM_DISABLED', 'enable the shared team first');
    const cleanTask = String(task || '').trim().slice(0, 4000);
    ensure(cleanTask.length > 0, 'SUBAGENT_TASK_EMPTY', 'task is required');
    ensure(provider && provider.baseUrl, 'SUBAGENT_NO_PROVIDER', 'provider required');
    const runId = 'sub-' + randomUUID().slice(0, 8);
    const url = provider.baseUrl.endsWith('/v1')
      ? `${provider.baseUrl}/chat/completions`
      : `${provider.baseUrl}/v1/chat/completions`;
    const systemPrompt = `你是 Threadline Studio 派生的无心智轻量工具子 Agent（角色：${role}）。你不具备情绪与人格负担，请直接、准确、结构化地完成任务并返回结果。`;
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? {authorization: `Bearer ${provider.apiKey}`} : {}),
      },
      body: JSON.stringify({
        model: provider.model || 'deepseek-chat',
        temperature: 0.2,
        messages: [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: cleanTask},
        ],
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`Sub-Agent HTTP ${res.status}`), {code: 'SUBAGENT_API_ERROR'});
    const data = await res.json();
    const output = data.choices?.[0]?.message?.content || '';
    const record = {id: runId, role, task: cleanTask.slice(0, 120), output: output.slice(0, 4000), ts: Date.now()};
    bus.subAgentRuns.unshift(record);
    if (bus.subAgentRuns.length > 20) bus.subAgentRuns = bus.subAgentRuns.slice(0, 20);
    persist();
    return record;
  }

  function state() {
    return {
      teamEnabled: bus.teamEnabled,
      sharedDir,
      sharedFiles: listSharedFiles(),
      messages: bus.messages.slice(-40),
      subAgentRuns: bus.subAgentRuns.slice(0, 10),
    };
  }

  return {state, setTeamEnabled, postTeamMessage, writeSharedFile, runMindlessSubAgent};
}
