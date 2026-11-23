import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadOfficialUsage,officialUsageGate} from '../src/official-usage.mjs';

const day='2026-11-16';
const cost='user_id,start_time_iso,end_time_iso,model,name,wallet_type,cost,currency\n'
  +'u,2026-11-16T01:00:00+08:00,2026-11-16T02:00:00+08:00,deepseek-flash,deepseek-flash,Paid,0.4398886000000000,CNY\n';
const amount='user_id,start_time_iso,end_time_iso,model,name,api_key_name,api_key,type,price,amount\n'
  +'u,2026-11-16T01:00:00+08:00,2026-11-16T02:00:00+08:00,deepseek-flash,deepseek-flash,Threadline Agent,sk-xxx,request_count,,17\n';

test('reads official cost for the selected Beijing day',()=>{
  const dir=mkdtempSync(join(tmpdir(),'official-usage-'));
  try{
    writeFileSync(join(dir,'cost-2026-11-16.csv'),cost);
    writeFileSync(join(dir,'amount-2026-11-16.csv'),amount);
    const u=loadOfficialUsage({directory:dir,day});
    assert.equal(u.known,true);
    assert.equal(u.spendMicros,439889);
    assert.equal(u.keyAttribution,'matched');
    assert.equal(officialUsageGate({directory:dir,day}).allow,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('missing official data is not treated as zero and does not open the gate',()=>{
  const dir=mkdtempSync(join(tmpdir(),'official-usage-empty-'));
  try{
    const u=loadOfficialUsage({directory:dir,day});
    assert.equal(u.known,false);
    assert.equal(officialUsageGate({directory:dir,day}).allow,false);
    assert.equal(officialUsageGate({directory:dir,day}).reason,'OFFICIAL_USAGE_UNKNOWN');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
