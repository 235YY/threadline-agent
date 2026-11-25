#!/usr/bin/env node
// Check the Studio runtime before opening the application.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {assertSupportedNode} from '../tools/brain-service/runtime-config.mjs';
import {MIRROR_PRESETS} from '../src/runtime-components.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const portableData = join(root, 'data');
if (existsSync(join(root, 'portable.flag')) && !process.env.THREADLINE_DATA_DIR) {
  process.env.THREADLINE_DATA_DIR = portableData;
}

try {
  assertSupportedNode();
  const args = [join(root, 'scripts/local-demo.mjs'), ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, {stdio: 'inherit', env: process.env});
  child.on('error', error => { console.error(error.message); process.exitCode=1; });
  child.on('exit', code => process.exit(code ?? 1));
} catch {
  console.log('\n============================================================');
  console.log(`Threadline Studio 检测到当前本机 Node 版本为 ${process.version}`);
  console.log('请使用正式版 Node.js 26.8+，或将便携版解压到 runtime/node/。');
  console.log(`      国内镜像：${MIRROR_PRESETS.cn.nodeBase}/latest-v26.x/`);
  console.log(`      官方源  ：${MIRROR_PRESETS.official.nodeBase}/latest-v26.x/\n\n`);
  console.log('============================================================\n');
  process.exit(1);
}
