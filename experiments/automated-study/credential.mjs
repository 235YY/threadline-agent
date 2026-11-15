import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ensure} from '../../src/contracts.mjs';

const script = fileURLToPath(new URL('../../scripts/study-key.ps1', import.meta.url));
export const keyPath = fileURLToPath(new URL('../../_local/study-secrets/deepseek-study.dpapi', import.meta.url));
export const keyConfigured = () => existsSync(keyPath);
// No fallback to the pet's credentials, environment or API-key files.
export function studyKey({spawn = spawnSync, available = keyConfigured} = {}) {
  ensure(available(), 'STUDY_KEY_REQUIRED', 'Fill the dedicated local key dialog first');
  const result = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ReadForWorker'],
    {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
  const key = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  ensure(result.status === 0 && !result.error && /^sk-[A-Za-z0-9_-]{12,}$/.test(key),
    'STUDY_KEY_REQUIRED', 'Dedicated key unavailable; no API request sent');
  return key;
}
