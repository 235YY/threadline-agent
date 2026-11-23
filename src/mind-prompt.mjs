import {readFileSync} from 'node:fs';
import {ensure} from './contracts.mjs';
import {generationSets} from './prompt-generations.mjs';
// Per prompt generation, for verifying packets sealed by an older generation.
export const MIND_EXTENSIONS=generationSets(read=>read('decision-mind.zh.md'));
const extension=MIND_EXTENSIONS.current;
const originalKinds='feeling/appraisal/intention/tension/activity';
const expandedKinds=originalKinds+'/concern/condition/expectation/readiness';

// Compile one consistent protocol rather than appending a second, contradictory whitelist.
export function withMindInstructions(base,mindExtension=extension){
  ensure(typeof base==='string'&&base.includes(originalKinds),'MIND_PROMPT_BASE','expected a personal-state protocol');
  const updated=base.replaceAll(originalKinds,expandedKinds)
    // Same three first-match rewrites as before; a field list may also open with expectedRevision.
    .replace(/(可含(?:expectedRevision、)?kind、body、status、scope、basis、reason)；/,'$1、mind；')
    .replace(/(可含(?:expectedRevision、)?kind、body、status、scope、basis、reason)。/,'$1、mind。')
    .replace(/(可含(?:expectedRevision、)?kind、body、status、scope、basis)。/,'$1、mind。');
  ensure(updated.includes('basis、reason、mind')||updated.includes('basis、mind'),'MIND_PROMPT_BASE','state field declaration was not extended');
  return updated+'\n\n'+mindExtension;
}
