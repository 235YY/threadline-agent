// Every prompt generation that has sealed a packet. Packets are verified by
// rebuilding them from prompt text, so archived generations must stay loadable.
// Current first; archived snapshots are complete and immutable (prompts/archive/README.md).
import {readFileSync} from 'node:fs';
export const ARCHIVED_PROMPT_GENERATIONS=Object.freeze(['r008','r007','r006']);
const ROOT=new URL('../prompts/',import.meta.url);
export const promptReader=(generation=null)=>{
  const dir=generation?new URL(`archive/${generation}/`,ROOT):ROOT;
  return name=>readFileSync(new URL(name,dir),'utf8');
};
// Build one value per generation lazily; archived ones only when verification needs them.
// A prompt introduced after a generation was archived simply has no packets from that
// generation; such generations are skipped (missing file only, never other errors).
const tryBuild=(build,g)=>{try{return build(promptReader(g));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
export function generationSets(build){
  const current=build(promptReader());let archived=null;
  const old=()=>archived??=ARCHIVED_PROMPT_GENERATIONS.map(g=>tryBuild(build,g));
  // byName is for audit/tests: what an archived generation would have produced.
  return {current,all:()=>[current,...old().filter(Boolean)],byName:name=>name===null?current:old()[ARCHIVED_PROMPT_GENERATIONS.indexOf(name)]??null};
}
