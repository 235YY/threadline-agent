// Explicit offline regression selection. No recursive discovery of archived projects.
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertSupportedNode} from '../tools/brain-service/runtime-config.mjs';

assertSupportedNode();
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(readFileSync(new URL('./current-test-files.json',import.meta.url),'utf8'));
if(manifest.format!=='jingyang-current-offline-tests-v1'||!Array.isArray(manifest.files)||new Set(manifest.files).size!==manifest.files.length)throw Error('invalid current test selection');
for(const file of manifest.files)if(!/^test\/[a-z0-9.-]+\.test\.mjs$/.test(file)||!existsSync(resolve(root,file)))throw Error('invalid test entry');
console.log(`Current offline core regression: ${manifest.files.length} files; historical archives are not auto-run.`);
const result=spawnSync(process.execPath,['--test',...process.argv.slice(2),...manifest.files],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
