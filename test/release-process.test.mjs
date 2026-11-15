import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startBrainService} from '../tools/brain-service/server.mjs';
import {inspectProcess,processMatches} from '../tools/ops/owned-process.mjs';
import {stopOwned} from '../tools/ops/stop-owned.mjs';

const childFile=new URL('./fixtures/release-child.mjs',import.meta.url);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'jingyang-release-process-')),children=[],owned=[];
  t.after(async()=>{for(const record of owned){if(processMatches(record,inspectProcess(record.pid)))await stopOwned(record,{force:true,waitMs:1000});}for(const c of children)if(c.exitCode===null&&c.signalCode===null){c.kill();await once(c,'exit').catch(()=>{});}assert.equal(dirname(dir),tmpdir());rmSync(dir,{recursive:true,force:true});});
  const spawn=args=>{const c=fork(childFile,args,{silent:true,windowsHide:true});children.push(c);c.messages=[];c.on('message',m=>c.messages.push(m));return c;};return {dir,spawn,owned};}
async function wait(c,type){const deadline=Date.now()+15000;while(Date.now()<deadline){const found=c.messages.find(m=>m.type===type);if(found)return found;if(c.exitCode!==null)throw Error('child exited: '+c.exitCode);await new Promise(r=>setTimeout(r,20));}throw Error('child deadline: '+type);}

test('两个独立进程争同一任务租约，只允许一个模型机会及一次终结',async t=>{
  const f=setup(t),db=join(f.dir,'subject.sqlite'),s=await startBrainService({port:0,storePath:db,heartbeatMs:0,global:true,subjectTask:true});
  const task=await s.createAgentTask({goal:'cross-process'});await new Promise(r=>s.server.close(r));s.close();
  const a=f.spawn(['lease',db,task.id]),b=f.spawn(['lease',db,task.id]);await Promise.all([wait(a,'ready'),wait(b,'ready')]);a.send('go');b.send('go');
  const result=await Promise.all([wait(a,'result'),wait(b,'result')]);await Promise.all([a.exitCode===null?once(a,'exit'):null,b.exitCode===null?once(b,'exit'):null]);
  assert.equal([...a.messages,...b.messages].filter(m=>m.type==='model').length,1);
  assert.equal(result.filter(r=>r.result.status==='done').length,1);
});

test('真实隔离子进程用本机管理入口优雅停止，清理自身标记且不建模型账本',async t=>{
  const f=setup(t);writeFileSync(join(f.dir,'identity.txt'),'隔离的工程测试身份');const c=f.spawn(['brain',f.dir]);const {url}=await wait(c,'ready');
  const instance=JSON.parse(readFileSync(join(f.dir,'state/brain.instance.json'),'utf8'));
  const wrong=await fetch(url+'/v1/admin/shutdown',{method:'POST',headers:{'x-jingyang-control':'wrong'}});assert.equal(wrong.status,400);
  const health=await (await fetch(url+'/health')).json();assert.equal(health.draining,false);
  const done=once(c,'exit'),r=await fetch(url+'/v1/admin/shutdown',{method:'POST',headers:{'x-jingyang-control':instance.shutdownToken}});assert.equal(r.status,202);await done;
  assert.equal(existsSync(join(f.dir,'state/brain.launch.lock')),false);assert.equal(existsSync(join(f.dir,'state/brain.instance.json')),false);assert.equal(existsSync(join(f.dir,'budget.json')),false);
});

test('Windows 启动器保存真实出生时间，文件通知可停止自己启动的进程', {skip:process.platform!=='win32'}, async t=>{
  const f=setup(t),entry=join(f.dir,'controlled.mjs');
  writeFileSync(entry,`import {installProcessControl} from ${JSON.stringify(new URL('../src/process-control.mjs',import.meta.url).href)};\nsetInterval(()=>{},1000);installProcessControl(async()=>process.exit(0));\n`);
  const launcher=new URL('../tools/ops/spawn-background.mjs',import.meta.url);
  execFileSync(process.execPath,[fileURLToPath(launcher),f.dir,join(f.dir,'ui.out.log'),join(f.dir,'ui.err.log'),entry],{encoding:'utf8',windowsHide:true});
  const record=JSON.parse(readFileSync(join(f.dir,'ui.process.json'),'utf8'));
  f.owned.push(record);
  assert.equal(processMatches(record,inspectProcess(record.pid)),true);
  const result=await stopOwned(record,{waitMs:5000});assert.equal(result.status,'stopped');
});
