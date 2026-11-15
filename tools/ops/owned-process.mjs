import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ensure} from '../../src/contracts.mjs';

export function inspectProcess(pid){
  ensure(Number.isSafeInteger(pid)&&pid>0,'PROCESS_ID','positive process id required');
  if(process.platform!=='win32')throw Object.assign(Error('Windows process identity required'),{code:'PROCESS_PLATFORM'});
  const command=`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -ne $p){ @{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:10000});
  return raw.trim()?JSON.parse(raw):null;
}
const norm=x=>resolve(x).replaceAll('\\','/').toLowerCase();
export function processMatches(record,current){
  if(!record||!current||record.pid!==current.pid||!record.createdAt||record.createdAt!==current.createdAt||!record.entry||!record.executable||!current.executable)return false;
  const escaped=record.entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return norm(record.executable)===norm(current.executable)&&new RegExp(`(?:^|\\s)"?${escaped}"?(?=\\s|$)`,'i').test(current.commandLine??'');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const file=process.argv[process.argv.indexOf('--record')+1];const record=JSON.parse(readFileSync(file,'utf8'));const matches=processMatches(record,inspectProcess(record.pid));console.log(JSON.stringify({matches}));if(!matches)process.exitCode=1;}
