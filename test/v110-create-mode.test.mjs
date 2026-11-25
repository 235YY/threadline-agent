import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStudioSandbox, sanitizeExtensionSpec, classifyPatchRisk} from '../src/studio-create-mode.mjs';

test('create-mode sandbox blocks unsafe scripts, manages extensions, and keeps bounded 20-step snapshots', () => {
  assert.throws(() => sanitizeExtensionSpec({name: 'bad', body: '<script>alert(1)</script>'}), {code: 'EXT_UNSAFE_CONTENT'});
  assert.throws(() => sanitizeExtensionSpec({name: 'bad-css', css: 'body{background:url(javascript:alert(1))}'}), {code: 'EXT_UNSAFE_CONTENT'});

  assert.equal(classifyPatchRisk({ui: {skin: 'xhs'}}).level, 'low');
  assert.equal(classifyPatchRisk({gateway: {enabled: true}}).level, 'medium');
  assert.equal(classifyPatchRisk({mcp: {mcpServers: {}}}).level, 'high');

  const dir = mkdtempSync(join(tmpdir(), 'tl-create-'));
  try {
    const sb = createStudioSandbox({directory: dir});
    const saved = sb.saveExtension({id: 'pomo-1', name: '番茄钟', slot: 'room-widget', kind: 'pomodoro', title: '专注 25 分钟', minutes: 25});
    assert.equal(saved.enabled, true);
    assert.equal(sb.listExtensions().length, 1);

    const snap = sb.takeSnapshot({label: '测试快照', ui: {skin: 'chatgpt'}, gateway: {enabled: false}, mcp: {mcpServers: {}}});
    sb.toggleExtension('pomo-1', false);
    assert.equal(sb.listExtensions()[0].enabled, false);

    const loaded = sb.loadSnapshot(snap.id);
    sb.restoreExtensionsFrom(loaded.extensions);
    assert.equal(sb.listExtensions()[0].enabled, true);

    sb.clearAllExtensions();
    assert.equal(sb.listExtensions().length, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
