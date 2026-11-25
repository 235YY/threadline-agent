import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildSelectivePack, convertPackToPatch, createCommunityStore} from '../src/studio-community.mjs';

test('studio-community builds privacy-safe selective packs and converts to approval patch', () => {
  const pack = buildSelectivePack({
    profile: {
      characterName: '小鲸',
      identity: '十四岁鲸鱼娘',
      style: '短句口语化',
      reasoning: 'low',
      autoDream: true,
      ui: {skin: 'xhs', theme: 'paper', layout: 'portrait', accent: '#e55360', customCss: '/* clean */'},
      parameters: {reactivity: 1.1},
      qq: {bot: '12345', owner: '67890'},
      gateway: {apiKey: 'sk-should-never-leak'},
    },
    activeResident: {tagline: '温柔又傲娇', roleMode: 'companion'},
    extensions: [{id: 'pomo', name: '番茄钟', slot: 'room-widget', kind: 'pomodoro', title: '专注', minutes: 25, enabled: true}],
    publicNotes: [{kind: 'preference', body: '喜欢听海浪声'}],
    include: {persona: true, skin: true, limbic: false, extensions: true, notes: true},
    author: '235YY',
    title: '鲸漾清爽分享包',
  });

  const serialized = JSON.stringify(pack);
  assert.doesNotMatch(serialized, /sk-should-never-leak/);
  assert.doesNotMatch(serialized, /12345/);
  assert.equal(pack.format, 'threadline-pack-v1');
  assert.equal(pack.limbic, undefined);
  assert.equal(pack.extensions.length, 1);
  assert.equal(pack.notes.length, 1);

  const patch = convertPackToPatch(pack);
  assert.equal(patch.format, 'threadline-patch-v1');
  assert.equal(patch.resident.name, '小鲸');
  assert.equal(patch.ui.skin, 'xhs');
});

test('studio-community persists custom community channels safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-comm-'));
  try {
    const store = createCommunityStore({directory: dir});
    const defaults = store.listChannels();
    assert.ok(defaults.length >= 5);
    defaults[1].code = 'QQ频道：Threadline官方';
    store.saveChannels(defaults);
    assert.equal(store.listChannels()[1].code, 'QQ频道：Threadline官方');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
