// Production transport boundary extracted without changing request/charging policy.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ensure} from './contracts.mjs';

const script = fileURLToPath(new URL('../scripts/study-key.ps1', import.meta.url));
export const keyPath = fileURLToPath(new URL('../_local/study-secrets/deepseek-study.dpapi', import.meta.url));
export const keyConfigured = () => Boolean(process.env.DEEPSEEK_API_KEY)||existsSync(keyPath);
// Explicit environment configuration or the operator-created local Windows store only.
export function studyKey({spawn = spawnSync, available = keyConfigured} = {}) {
  const environmentKey=process.env.DEEPSEEK_API_KEY;
  if(environmentKey){ensure(/^sk-[A-Za-z0-9_-]{12,}$/.test(environmentKey),'STUDY_KEY_REQUIRED','Invalid DEEPSEEK_API_KEY');return environmentKey;}
  ensure(available(), 'STUDY_KEY_REQUIRED', 'Set DEEPSEEK_API_KEY or configure the optional Windows local key store');
  const result = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ReadForWorker'],
    {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
  const key = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  ensure(result.status === 0 && !result.error && /^sk-[A-Za-z0-9_-]{12,}$/.test(key),
    'STUDY_KEY_REQUIRED', 'Dedicated key unavailable; no API request sent');
  return key;
}
