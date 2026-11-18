// Production Open-Life host builder: wires persistent openLifePolicy and
// OneBot / public-read / sandboxed-office tool adapters into launchBrain().
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensure } from '../../src/contracts.mjs';
import { openLifePolicy } from './policy.mjs';
import { configureLifeTools } from './tools.mjs';
import { oneBotCall } from '../qq-connect/tools.mjs';

export function createOpenLifeHost({
  root = process.cwd(),
  stateDirectory,
  botId,
  ownerId,
  officeRoot = null,
  voiceDirectory = null,
  storeGetter = () => null,
  onebot = oneBotCall,
} = {}) {
  ensure(typeof stateDirectory === 'string' && stateDirectory.trim(), 'LIFE_CONFIG', 'stateDirectory required for Open Life policy');
  ensure(/^\d+$/.test(String(botId ?? '')), 'LIFE_CONFIG', 'QQ_UIN is required for Open Life policy');
  ensure(/^\d+$/.test(String(ownerId ?? '')), 'LIFE_CONFIG', 'QQ_OWNER or QQ_TEST_ONLY_OWNER is required for Open Life policy');

  mkdirSync(stateDirectory, { recursive: true });
  const resolvedOffice = resolve(root, officeRoot ?? join(stateDirectory, 'office-workspace'));
  mkdirSync(resolvedOffice, { recursive: true });

  const policy = openLifePolicy({
    file: join(stateDirectory, 'open-life-policy.json'),
    botId: String(botId),
    ownerId: String(ownerId),
    store: storeGetter,
  });

  configureLifeTools({
    policy,
    onebot,
    knownTargets: async () => {
      const [friends, groups] = await Promise.all([onebot('get_friend_list'), onebot('get_group_list')]);
      return new Set([
        ...(Array.isArray(friends) ? friends.map(f => `qq/private/${f.user_id}`) : []),
        ...(Array.isArray(groups) ? groups.map(g => `qq/group/${g.group_id}`) : []),
      ]);
    },
    officeRoot: resolvedOffice,
    ...(voiceDirectory ? { voiceDirectory: resolve(root, voiceDirectory) } : {}),
  });

  return { policy, officeRoot: resolvedOffice };
}
