import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStudioRoster} from '../src/studio-roster.mjs';
import {THREADLINE_CONFIG_PROTOCOL_V1, extractPatchJson, buildPatchPreview, askStudioCopilot} from '../src/studio-copilot.mjs';

test('studio-roster isolates multi-resident directories, manages multi-API pool, and keeps keys in memory only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-roster-'));
  try {
    const roster = createStudioRoster({directory: dir, defaultName: '鲸漾'});
    assert.equal(roster.snapshot().residents.length, 1);

    const addedProv = roster.upsertProvider({label: 'Claude 中转', baseUrl: 'https://api.example.com/v1', model: 'claude-sonnet'}, 'sk-secret-memory-only');
    assert.equal(addedProv.hasKey, true);
    // Security invariant: API key must never touch disk
    assert.doesNotMatch(readFileSync(join(dir, 'studio-roster.json'), 'utf8'), /sk-secret-memory-only/);

    const res2 = roster.createResident({name: '林深', tagline: '代码搭子', roleMode: 'agent', providerId: addedProv.id, permissions: {workspaceRead: true, mcpWrite: false}});
    assert.equal(res2.roleMode, 'agent');
    assert.equal(res2.permissions.workspaceRead, true);
    assert.notEqual(roster.residentDirectory('primary'), roster.residentDirectory(res2.id));

    roster.setActiveResident(res2.id);
    assert.equal(roster.activeResident().id, res2.id);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('studio-copilot extracts external AI JSON, generates approval diff preview, and queries copilot API', async () => {
  assert.match(THREADLINE_CONFIG_PROTOCOL_V1, /threadline-patch-v1/);
  const raw = '好的，这是配置：\n```json\n{"format":"threadline-patch-v1","summary":"切到极客风并新建搭子","resident":{"createNew":true,"name":"阿柚","roleMode":"agent","daily":3},"ui":{"skin":"vscode"}}\n```';
  const patch = extractPatchJson(raw);
  const preview = buildPatchPreview({
    patch,
    currentProfile: {characterName: '鲸漾', daily: 5, reasoning: 'low', autoDream: true, ui: {skin: 'chatgpt'}},
    activeResident: {roleMode: 'companion'},
  });
  assert.ok(preview.proposalId.startsWith('prop-'));
  assert.ok(preview.changes.some(c => c.area === '新建数字生命'));
  assert.ok(preview.changes.some(c => c.area === '外观' && c.after === 'vscode'));

  const fakeFetch = async () => new Response(JSON.stringify({
    choices: [{message: {content: raw}}],
  }), {status: 200, headers: {'content-type': 'application/json'}});

  const out = await askStudioCopilot({
    instruction: '帮我新建一个搭子阿柚并切到 VS Code 风',
    currentState: {residentsCount: 1},
    provider: {baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test'},
    fetchImpl: fakeFetch,
  });
  assert.equal(out.patch.resident.name, '阿柚');
});
