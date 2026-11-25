import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSkillStore, parseSkillMarkdown} from '../src/studio-skills.mjs';
import {createTeamHub} from '../src/studio-team.mjs';

test('studio-skills parses, persists, toggles, and builds active SKILL.md prompt blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-skill-'));
  try {
    const store = createSkillStore({residentDir: dir});
    const s = store.save({name: '代码审查官', description: '严格检查边界条件', body: '1. 检查空值\n2. 检查安全'});
    assert.equal(s.enabled, true);
    assert.match(store.activePromptBlock(), /代码审查官/);
    store.toggle(s.id, false);
    assert.equal(store.activePromptBlock(), '');
    const parsed = parseSkillMarkdown('---\nname: test-skill\ndescription: demo\n---\nHello body', 'test-skill');
    assert.equal(parsed.name, 'test-skill');
    assert.equal(parsed.body, 'Hello body');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('studio-team manages shared workspace, inter-resident messages, and mindless sub-agent execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-team-'));
  try {
    const fakeFetch = async () => new Response(JSON.stringify({
      choices: [{message: {content: '子 Agent 任务已完成：共整理 3 项结果。'}}],
    }), {status: 200, headers: {'content-type': 'application/json'}});

    const hub = createTeamHub({directory: dir, fetchImpl: fakeFetch});
    assert.throws(() => hub.postTeamMessage({fromId:'primary',text:'未启用'}), {code:'TEAM_DISABLED'});
    assert.throws(() => hub.writeSharedFile({name:'plan.md',content:'未启用'}), {code:'TEAM_DISABLED'});
    await assert.rejects(hub.runMindlessSubAgent({task:'未启用'}), {code:'TEAM_DISABLED'});
    hub.setTeamEnabled(true);
    hub.postTeamMessage({fromId: 'primary', fromName: '鲸漾', toId: 'all', text: '把资料放到共享工作台了'});
    hub.writeSharedFile({name: 'plan.md', content: '# 协作计划'});
    const run = await hub.runMindlessSubAgent({
      role: '资料整理子 Agent',
      task: '整理三点摘要',
      provider: {baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test'},
    });
    assert.match(run.output, /任务已完成/);
    const st = hub.state();
    assert.equal(st.teamEnabled, true);
    assert.equal(st.messages.length, 1);
    assert.equal(st.sharedFiles.some(f => f.name === 'plan.md'), true);
    assert.equal(st.subAgentRuns.length, 1);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
