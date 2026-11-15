param([switch]$Force)
# Only processes with matching creation time, executable and exact entry are controlled.
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$portable=Join-Path $root '_runtime\node-v26.12.1\node.exe'
$node=$(if(Test-Path -LiteralPath $portable){$portable}else{(Get-Command node).Source})
$arguments=@((Join-Path $root 'tools/ops/stop-owned.mjs'),'--root',$root)
if($Force){$arguments+='--force'}
& $node @arguments
if($LASTEXITCODE -ne 0){throw 'Some processes were preserved. Review the reported ownership or in-flight work; no broad process kill was attempted.'}
