import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function verifyCandidate(){const root=fileURLToPath(new URL('../../',import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'MANIFEST.json')));for(const [file,expected] of Object.entries(manifest.files)){const path=join(root,file);if(!existsSync(path)||createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw Error('CANDIDATE_CHANGED:'+file);}return {ok:true,files:Object.keys(manifest.files).length,schema:manifest.schema};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(verifyCandidate()));
