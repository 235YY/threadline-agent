import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimConnector} from '../tools/qq-connect/connector-guard.mjs';

test('connector guard rejects a live owner',()=>{
  const root=mkdtempSync(join(tmpdir(),'jy-connector-guard-'));
  writeFileSync(join(root,'qq-7000000001.lock'),JSON.stringify({instanceId:'live',pid:process.pid,botId:'7000000001'}));
  assert.throws(()=>claimConnector({root,botId:'7000000001'}),e=>e.code==='CONNECTOR_OWNED');
  rmSync(root,{recursive:true,force:true});
});

test('connector guard quarantines a dead owner and claims the lock',()=>{
  const root=mkdtempSync(join(tmpdir(),'jy-connector-guard-'));
  writeFileSync(join(root,'qq-7000000001.lock'),JSON.stringify({instanceId:'dead',pid:99999999,botId:'7000000001'}));
  const claim=claimConnector({root,botId:'7000000001'});
  assert.equal(JSON.parse(readFileSync(join(root,'qq-7000000001.lock'),'utf8')).instanceId,claim.instanceId);
  assert.equal(readdirSync(root).filter(x=>x.startsWith('qq-7000000001.lock.stale-')).length,1);
  claim.close();
  assert.deepEqual(readdirSync(root).filter(x=>x==='qq-7000000001.lock'),[]);
  rmSync(root,{recursive:true,force:true});
});

test('connector guard refuses malformed ownership evidence',()=>{
  const root=mkdtempSync(join(tmpdir(),'jy-connector-guard-'));
  writeFileSync(join(root,'qq-7000000001.lock'),'{bad');
  assert.throws(()=>claimConnector({root,botId:'7000000001'}),e=>e.code==='CONNECTOR_OWNED');
  rmSync(root,{recursive:true,force:true});
});
