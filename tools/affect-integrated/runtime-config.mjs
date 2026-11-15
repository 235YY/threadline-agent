import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ensure} from '../../src/contracts.mjs';
export function affectRuntimeConfig({root=process.cwd(),env=process.env}={}){
 const file=resolve(root,'_local/ops/affect-active.json');
 const active=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
 if(active)ensure(active.format==='jingyang-affect-install-v1'&&active.enabled===true&&active.schema===11,'AFFECT_ACTIVE_CONFIG','invalid deployment pointer');
 const enabled=env.JY_AFFECT==='1'||(!!active&&env.JY_AFFECT!=='0');
 ensure(!(active&&env.JY_AFFECT==='0'&&!env.BRAIN_STORE),'AFFECT_ACTIVE_CONFIG','rollback needs an explicit original store');
 const storePath=resolve(root,env.BRAIN_STORE??active?.storePath??'_local/brain/subject.sqlite');
 return {enabled,storePath,activeFile:active?file:null,rollbackStorePath:active?.rollbackStorePath??null};
}
