// Run only on an isolated copy while its service is stopped.
import {statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ContinuityStore} from '../../src/store.mjs';
const [mode,path,extra]=process.argv.slice(2);
if(!['--repack','--expand'].includes(mode)||!path||extra||!statSync(path).isFile())
  throw Error('usage: node tools/ops/runtime-storage.mjs --repack|--expand <offline sqlite copy>');
const db=new ContinuityStore(path);
let summary;
try{summary=db.repackRuntimeStorage({expand:mode==='--expand'});}finally{db.close();}
const verify=new DatabaseSync(path);
try{
  verify.exec('VACUUM');
  if(verify.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('compacted database did not pass quick_check');
}finally{verify.close();}
console.log(JSON.stringify({...summary,bytes:statSync(path).size}));

