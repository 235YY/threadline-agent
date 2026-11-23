// Read frozen prior bytes without replacing the working tree or touching historical databases.
import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
const {root}=JSON.parse(readFileSync('_local/acceptance/investigation-continuity-20261113/ENTERED.json'));
const frozen=JSON.parse(readFileSync(join(root,'BASELINE.json'))),files=new Map(frozen.files.map(x=>[resolve(x.file).toLowerCase(),x]));
registerHooks({load(url,context,next){if(url.startsWith('file:')){const r=files.get(fileURLToPath(url).toLowerCase());if(r&&r.file.endsWith('.mjs'))return {format:'module',source:readFileSync(join(root,'blobs',r.sha256),'utf8'),shortCircuit:true};}return next(url,context);}});
