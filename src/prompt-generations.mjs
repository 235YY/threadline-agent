// Every prompt generation that has sealed a packet. Packets are verified by
// rebuilding them from prompt text, so archived generations must stay loadable.
// Current first; archived snapshots are complete and immutable (prompts/archive/README.md).
import {readFileSync} from 'node:fs';
export const ARCHIVED_PROMPT_GENERATIONS=Object.freeze(['r006']);
const ROOT=new URL('../prompts/',import.meta.url);
export const promptReader=(generation=null)=>{
  const dir=generation?new URL(`archive/${generation}/`,ROOT):ROOT;
  return name=>readFileSync(new URL(name,dir),'utf8');
};
// Build one value per generation lazily; archived ones only when verification needs them.
export function generationSets(build){
  const current=build(promptReader());let archived=null;
  return {current,all:()=>[current,...(archived??=ARCHIVED_PROMPT_GENERATIONS.map(g=>build(promptReader(g))))]};
}
