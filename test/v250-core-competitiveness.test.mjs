import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createSensoryGate} from '../src/sensory-gate.mjs';
import {createEncryptedCapsule, restoreEncryptedCapsule, buildWeeklyDreamDigest} from '../src/time-capsule.mjs';
import {createEcosystemGateway} from '../src/openai-gateway.mjs';

test('SensoryGate enforces L0 default, L1-L3 levels, hard sensitive blacklist, coarse location, Curtain Mode, and computer-control gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sensory-'));
  try {
    const gate = createSensoryGate({stateFile: join(dir, 'sensory-policy.json')});
    // Default L0 blocks L1 activity
    assert.equal(gate.ingestSignal({source: 'aw', kind: 'activity', app: 'Code.exe', summary: '写代码'}).accepted, false);

    // Enable L1 globally
    gate.updatePolicy({globalLevel: 'L1'});
    assert.equal(gate.ingestSignal({source: 'aw', kind: 'activity', app: 'Code.exe', summary: '在 VS Code 写代码 40 分钟'}).accepted, true);
    // L2 screen_peek still blocked at L1
    assert.equal(gate.ingestSignal({source: 'screen', kind: 'screen_peek', summary: '看一眼屏幕'}).accepted, false);

    // Hard-blocked banking/password apps always rejected even at L3
    gate.updatePolicy({globalLevel: 'L3'});
    assert.equal(gate.ingestSignal({source: 'aw', kind: 'activity', app: '1Password.exe', summary: '查看密码'}).reason, 'SENSITIVE_BLOCKED');
    assert.equal(gate.ingestSignal({source: 'browser', kind: 'activity', domain: 'ebank.icbc.com.cn', summary: '网银转账'}).reason, 'SENSITIVE_BLOCKED');

    // Raw GPS coordinates rejected; coarse place allowed
    assert.equal(gate.ingestSignal({source: 'phone', kind: 'location', summary: '31.2304, 121.4737'}).reason, 'RAW_COORDINATES_NOT_ALLOWED');
    assert.equal(gate.ingestSignal({source: 'phone', kind: 'location', summary: '在家附近 · 小雨 16°C'}).accepted, true);

    // Per-resident ACL caps a work resident to L0 even when global is L3
    gate.updatePolicy({residentLevels: {worker1: 'L0'}});
    assert.equal(gate.effectiveLevel('worker1'), 'L0');
    assert.equal(gate.ingestSignal({source: 'aw', kind: 'activity', residentId: 'worker1', summary: '写代码'}).accepted, false);

    // Prompt summary contains allowed signals only
    assert.equal(gate.ingestSignal({source:'aw',kind:'activity',app:'Code.exe',summary:'在 VS Code 写代码 40 分钟'}).accepted,true);
    assert.equal(gate.ingestSignal({source:'phone',kind:'location',summary:'在家附近 · 小雨 16°C'}).accepted,true);
    const prompt = gate.buildSensoryPrompt('jingyang');
    assert.ok(prompt.includes('VS Code'));
    assert.ok(prompt.includes('小雨'));
    assert.ok(!prompt.includes('1Password'));

    // Computer control requires explicit enable + approval
    assert.equal(gate.authorizeComputerAction({app: 'Notepad', action: 'type'}).allowed, false);
    gate.updatePolicy({computerControl: {enabled: true, requireApproval: true, allowedApps: ['Notepad'], emergencyStopped: false}});
    assert.equal(gate.authorizeComputerAction({app: 'Notepad', action: 'type', approved: false}).needsApproval, true);
    assert.equal(gate.authorizeComputerAction({app: 'Notepad', action: 'type', approved: true}).allowed, true);
    assert.equal(gate.authorizeComputerAction({action:'type',approved:true}).allowed,false);
    assert.equal(gate.authorizeComputerAction({app: 'PowerShell', action: 'rm', approved: true}).allowed, false);

    // Curtain Mode instantaneously wipes live signals and emergency-stops computer control
    gate.setCurtain(true);
    assert.equal(gate.activeSignals().length, 0);
    assert.equal(gate.authorizeComputerAction({app: 'Notepad', action: 'type', approved: true}).allowed, false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Time Capsule encrypts resident directory with AES-256-GCM, strips API keys, and restores cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-capsule-'));
  const src = join(dir, 'resident-src');
  const dst = join(dir, 'resident-dst');
  try {
    mkdirSync(join(src, 'skills'), {recursive: true});
    writeFileSync(join(src, 'settings.json'), JSON.stringify({name: '鲸漾', apiKey: 'sk-secret-must-strip', theme: 'minimal'}));
    writeFileSync(join(src, 'skills/study.md'), '# Study Helper\nBe concise.');

    const capsule = createEncryptedCapsule({residentDir: src, residentName: '鲸漾', passphrase: 'whale-passphrase-2026'});
    assert.equal(capsule.format, 'threadline-time-capsule-v1');
    assert.equal(capsule.fileCount, 2);
    assert.ok(!JSON.stringify(capsule).includes('sk-secret-must-strip'));

    // Wrong passphrase fails
    assert.throws(() => restoreEncryptedCapsule({capsule, targetDir: dst, passphrase: 'wrong-passphrase'}), /CAPSULE_DECRYPT_FAILED/);

    // Correct passphrase restores and keeps secret stripped
    const res = restoreEncryptedCapsule({capsule, targetDir: dst, passphrase: 'whale-passphrase-2026'});
    assert.equal(res.ok, true);
    assert.equal(res.restoredFiles, 2);
    const restoredSettings = JSON.parse(readFileSync(join(dst, 'settings.json'), 'utf8'));
    assert.equal(restoredSettings.name, '鲸漾');
    assert.equal(restoredSettings.apiKey, undefined);
    assert.ok(readFileSync(join(dst, 'skills/study.md'), 'utf8').includes('Study Helper'));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('capsule copies uncheckpointed SQLite facts and keeps an existing destination intact', () => {
  const dir=mkdtempSync(join(tmpdir(),'tl-capsule-snapshot-')),from=join(dir,'from'),to=join(dir,'to');
  mkdirSync(from);
  const db=new DatabaseSync(join(from,'subject.sqlite'));
  try{
    db.exec("PRAGMA journal_mode=wal; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(text); INSERT INTO notes VALUES ('saved fact')");
    const journal=JSON.stringify({requests:[{status:'uncertain',source:{key:'fixed-origin'}}]});
    writeFileSync(join(from,'requests.json'),journal);
    writeFileSync(join(from,'.env'),'DEMO_TOKEN=redacted-fixture');
    assert.equal(existsSync(join(from,'subject.sqlite-wal')),true);
    const passphrase='isolated-fixture-passphrase';
    const capsule=createEncryptedCapsule({residentDir:from,passphrase});
    assert.equal(capsule.fileCount,2);
    assert.equal(capsule.residentName,undefined);
    restoreEncryptedCapsule({capsule,targetDir:to,passphrase});
    assert.equal(readFileSync(join(to,'requests.json'),'utf8'),journal);
    assert.equal(existsSync(join(to,'subject.sqlite-wal')),false);
    const restored=new DatabaseSync(join(to,'subject.sqlite'),{readOnly:true});
    try{assert.equal(restored.prepare('SELECT text FROM notes').get().text,'saved fact');}finally{restored.close();}
    assert.throws(()=>restoreEncryptedCapsule({capsule,targetDir:to,passphrase}),{code:'CAPSULE_TARGET_EXISTS'});
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('Weekly Dream Digest generates zero-cost local narrative and highlights', () => {
  const now = Date.now();
  const digest = buildWeeklyDreamDigest({
    residentName: '鲸漾',
    now,
    notes: [{id: 'n1', kind: 'preference', body: '最近改喝冰美式', updatedAt: now - 3600_000}],
    states: [{id: 's1', kind: 'impression', body: '这周赶实验很拼', asOf: now - 7200_000}],
    events: [{occurredAt: now - 1000}, {occurredAt: now - 2000}],
  });
  assert.equal(digest.format, 'threadline-dream-digest-v1');
  assert.equal(digest.stats.interactions, 2);
  assert.equal(digest.stats.newNotes, 1);
  assert.equal(digest.highlights.length, 2);
  assert.ok(digest.narrative.includes('鲸漾'));
});

test('OpenAI gateway exposes /v1/context/signal and /v1/sensory/curtain protected by SensoryGate', async () => {
  const gate = createSensoryGate();
  gate.updatePolicy({globalLevel: 'L1'});
  const owner='fake-owner-gateway-key';
  const push=gate.issueClientToken({clientId:'weather',residentId:'resident-a',scopes:['sensory:push']});
  const read=gate.issueClientToken({clientId:'reader',residentId:'resident-b',scopes:['sensory:read']});
  const gw = createEcosystemGateway({
    getActiveResidentId:()=> 'resident-a',
    sensoryGate: gate,
    onChat: async () => ({reply: 'ok'}),
    getStatusSnapshot: () => ({}),
    getConfig: () => ({modelName:'threadline-brain',apiKey:owner}),
  });
  const {port:actualPort}=await gw.start({port:0});
  try {
    const base=`http://127.0.0.1:${actualPort}`;
    const post=(path,body,token)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    const data={kind:'weather',summary:'Synthetic weather'};
    assert.equal((await post('/v1/context/signal',data,null)).status,401);
    assert.equal((await post('/v1/context/signal',data,read.token)).status,403);
    assert.equal((await post('/v1/context/signal',{...data,residentId:'resident-b'},push.token)).status,403);
    assert.equal((await post('/v1/sensory/curtain',{curtain:true},push.token)).status,403);
    const r1 = await fetch(`http://127.0.0.1:${actualPort}/v1/context/signal`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization:'Bearer '+push.token},
      body: JSON.stringify({...data,source:'claimed-source'}),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.accepted,true);
    assert.equal(gate.activeSignals('resident-a')[0].source,'weather');
    assert.deepEqual(gate.activeSignals('resident-b'),[]);
    const readResult=await fetch(base+'/v1/sensory/status?residentId=resident-a',{headers:{authorization:'Bearer '+read.token}});
    assert.deepEqual((await readResult.json()).activeSignals,[]);

    const r2 = await fetch(`http://127.0.0.1:${actualPort}/v1/sensory/curtain`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization:'Bearer '+owner},
      body: JSON.stringify({curtain: true}),
    });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.curtain,true);
    assert.deepEqual(gate.activeSignals('resident-a'),[]);
    gate.revokeClient(push.clientId);
    assert.equal((await post('/v1/context/signal',data,push.token)).status,401);
  } finally {
    await gw.stop();
  }
});
