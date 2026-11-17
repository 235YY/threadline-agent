// Explicit local-only replay. The test code is public; the original evidence is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,copyFileSync,constants,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ContinuityStore} from '../../src/store.mjs';
import {commitDecision} from '../../src/cognition.mjs';
import {normalizeAndRecord} from '../../src/proposal-normalization.mjs';

const originals=[
 ['live-request-003.json','cff23faf97c17421b7971bd27a90ab13b84a86ee28a76f468413a967946eb0c5'],
 ['live-response-003.json','c669e34d9877f8f99632bb91d538ebcea6f2f38370d417b6bfb647633a0f1b3a'],
 ['live-ABC/subject.sqlite','3117cdf1417fd8cc2524b5679d0f348ad2cd69f9da8bd0a238dec575ed4431b8']
];
const sha=b=>createHash('sha256').update(b).digest('hex');
test('private original paid failure replays only from pinned evidence on a working database copy',t=>{
 assert.ok(process.env.JY_PRIVATE_REPLAY_ROOT,'JY_PRIVATE_REPLAY_ROOT is required; no private archive was read');
 const root=resolve(process.env.JY_PRIVATE_REPLAY_ROOT),db=join(root,originals[2][0]);
 assert.equal(existsSync(db+'-wal')||existsSync(db+'-shm'),false,'sealed standalone snapshot required; do not copy an active database');
 const bytes=new Map(originals.map(([file,hash])=>{const value=readFileSync(join(root,file));assert.equal(sha(value),hash,'original fixture hash '+file);return [file,value];}));
 const request=JSON.parse(bytes.get(originals[0][0])),response=JSON.parse(bytes.get(originals[1][0])),raw=JSON.parse(response.output);
 const dir=mkdtempSync(join(tmpdir(),'jy-private-original-replay-'));
 copyFileSync(db,join(dir,'work.sqlite'),constants.COPYFILE_EXCL);
 const store=new ContinuityStore(join(dir,'work.sqlite'));t.after(()=>store.close());
 assert.throws(()=>commitDecision({store,packet:request.packet,output:response.output,decisionId:'local-old-reject',requestId:'local-old-reject',maxOutputBytes:32768,allowedActionTools:request.packet.payload.allowedActionTools??[]}),e=>e.code==='OUTPUT_SHAPE');
 const normalized=normalizeAndRecord({store,packet:request.packet,output:response.output}),expected=structuredClone(raw);
 delete expected.options.find(o=>o.id===expected.selected).payload.tool;
 assert.deepEqual(normalized,expected);
 const record=[...store.all('extension_record')].find(x=>x.stateType==='proposal-normalization'&&x.value.rawOutput===response.output);
 assert.ok(record);
 // Original bytes are read only, including after Store initialization on the copy.
 for(const [file,hash] of originals)assert.equal(sha(readFileSync(join(root,file))),hash);
});
