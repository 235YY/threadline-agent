param(
  [switch]$Live,
  [switch]$QQ
)
# Safe start: default dry-run. Real model/QQ require -Live plus explicit env confirmation
# and a passing cumulative budget audit. This script never creates/reset a budget ledger.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$root=Resolve-Path (Join-Path $PSScriptRoot '..\..')
$ops=Join-Path $root '_local\ops'
$state=$(if($env:BRAIN_STATE){[IO.Path]::GetFullPath($env:BRAIN_STATE)}elseif($Live.IsPresent){Join-Path $root '_local\brain\state'}else{Join-Path $root '_local\dry-run\state'})
$tmp=Join-Path $root '_local\tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP=$tmp;$env:TMP=$tmp
$store=$(if($env:BRAIN_STORE){[IO.Path]::GetFullPath($env:BRAIN_STORE)}elseif($Live.IsPresent){Join-Path $root '_local\brain\subject.sqlite'}else{Join-Path $root '_local\dry-run\subject.sqlite'})
$affectFile=Join-Path $ops 'affect-active.json'
if(Test-Path -LiteralPath $affectFile){
  $affect=Get-Content -LiteralPath $affectFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($affect.format -ne 'jingyang-affect-install-v1' -or $affect.schema -ne 11 -or -not $affect.enabled){throw 'invalid affect installation pointer'}
  if($Live.IsPresent -and $env:JY_AFFECT -ne '0' -and -not $env:BRAIN_STORE){$store=$affect.storePath}
}
New-Item -ItemType Directory -Force -Path $ops,$state,(Split-Path $store) | Out-Null
$portableNode=Join-Path $root '_runtime\node-v26.12.1\node.exe'
$node=$(if(Test-Path $portableNode){$portableNode}else{(Get-Command node).Source})
function StartHiddenNode([string]$directory,[string]$stdout,[string]$stderr,[string]$entry){
  $result=& $node (Join-Path $root 'tools/ops/spawn-background.mjs') $directory $stdout $stderr $entry
  if($LASTEXITCODE -ne 0){throw 'background node launch failed'}
  return ($result | ConvertFrom-Json)
}

function PortOpen([int]$port){
  try{return (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)}catch{return $false}
}
function AssertOwned([string]$component){
  $record=Join-Path $ops "$component.process.json"
  if(-not (Test-Path -LiteralPath $record)){throw "$component ownership record missing; do not reuse a pid alone"}
  & $node (Join-Path $root 'tools/ops/owned-process.mjs') --record $record | Out-Null
  if($LASTEXITCODE -ne 0){throw "$component process identity mismatch; explicit recovery required"}
}
function Alive([int]$procId){
  if($procId -le 0){return $false}
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

$liveMode=$Live.IsPresent
if($liveMode -and $env:JY_LIVE_CONFIRM -ne 'YES'){throw 'live start refused: set JY_LIVE_CONFIRM=YES only after budget audit/approval'}
$qqMode=$liveMode -and $QQ.IsPresent

if($liveMode){
  $budgetDir=$(if($env:JY_BUDGET_DIR){$env:JY_BUDGET_DIR}else{Join-Path $root '_local\brain'})
  $auditRaw=& $node (Join-Path $root 'tools\ops\budget-audit.mjs') --dir $budgetDir --json
  if($LASTEXITCODE -ne 0){throw 'budget audit failed; real start refused'}
  $audit=$auditRaw | ConvertFrom-Json
  if(-not $audit.within){throw 'budget authorization/audit refused live start'}
  if($audit.unknownCalls -gt 0){throw "budget audit has $($audit.unknownCalls) unknown-cost requests; real start refused"}
  if($null -ne $audit.authorization.maxCalls -and $audit.calls -gt $audit.authorization.maxCalls){throw 'authorized call cap exceeded'}
  if($audit.micros -gt $audit.authorization.maxMicros){throw 'authorized cost cap exceeded'}
} else {
  $env:BRAIN_LIVE='0'
  $env:BRAIN_HEARTBEAT_MS='0'
}

# Set the effective request before checking/reusing an existing process.
$env:BRAIN_STATE=$state
$env:BRAIN_STORE=$store
if(-not $env:BRAIN_GLOBAL){$env:BRAIN_GLOBAL='1'}
if($liveMode){
  $env:BRAIN_LIVE='1'
  if(-not $env:BRAIN_HEARTBEAT_MS){$env:BRAIN_HEARTBEAT_MS='5000'}
  if(-not $env:JY_TASK_THREADS){$env:JY_TASK_THREADS='1'};if(-not $env:JY_SUBJECTIVE_DOMAINS){$env:JY_SUBJECTIVE_DOMAINS='1'};if(-not $env:JY_SUBJECTIVE_MEMORY -and -not $env:JY_SUBJECTIVE_MEMORY_V2){$env:JY_SUBJECTIVE_MEMORY_V2='1'}
} elseif(-not $env:BRAIN_STYLE_DIR){$env:BRAIN_STYLE_DIR=Join-Path $root '_local/dry-run/style'}
$expectedRaw=& $node (Join-Path $root 'tools/brain-service/runtime-config.mjs') --root $root
if($LASTEXITCODE -ne 0){throw 'runtime preflight failed; no brain/QQ start attempted'}
$expected=$expectedRaw | ConvertFrom-Json
$store=$expected.storePath
$state=$expected.stateDirectory
$env:BRAIN_STORE=$store
$env:BRAIN_STATE=$state
function WaitBrainReady([int]$expectedPid){
  $deadline=(Get-Date).AddSeconds(15)
  while((Get-Date) -lt $deadline){
    if(-not (Alive $expectedPid)){throw 'brain exited before readiness; inspect brain.err.log'}
    if(Test-Path -LiteralPath $instanceFile){
      try{$candidate=Get-Content -LiteralPath $instanceFile -Raw | ConvertFrom-Json}catch{$candidate=$null}
      if($null -ne $candidate -and $candidate.pid -eq $expectedPid -and $candidate.status -eq 'ready'){
        if($candidate.configFingerprint -ne $expected.configFingerprint -or $candidate.build.fingerprint -ne $expected.buildFingerprint){throw 'ready brain differs from requested configuration/source'}
        return
      }
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'brain readiness was not established; do not start QQ connector'
}

$brainPidFile=Join-Path $ops 'brain.pid'
$instanceFile=Join-Path $state 'brain.instance.json'
$brainId=0
if(Test-Path $brainPidFile){$brainId=[int](Get-Content $brainPidFile -Raw)}
if(Alive $brainId){
  AssertOwned brain
  if(-not (Test-Path $instanceFile)){throw 'existing brain pid has no verifiable instance metadata; refusing reuse'}
  $inst=Get-Content $instanceFile -Raw | ConvertFrom-Json
  $expectedMode=$(if($liveMode){'live'}else{'dry-run'})
  $expectedLedger=$(if($liveMode){[IO.Path]::GetFullPath($env:BRAIN_LEDGER)}else{$null})
  $actualLedger=$(if($inst.ledgerPath){[IO.Path]::GetFullPath($inst.ledgerPath)}else{$null})
  if($inst.status -ne 'ready' -or $inst.pid -ne $brainId -or $inst.configFingerprint -ne $expected.configFingerprint -or $inst.build.fingerprint -ne $expected.buildFingerprint){throw 'existing brain lacks matching ready/config/source evidence; refusing reuse'}
  if($inst.mode -ne $expectedMode -or [IO.Path]::GetFullPath($inst.storePath) -ne [IO.Path]::GetFullPath($store) -or $actualLedger -ne $expectedLedger){throw "existing brain mode/config mismatch: running=$($inst.mode) requested=$expectedMode"}
}
if(-not (Alive $brainId)){
  if($liveMode){
    $env:BRAIN_LIVE='1';if(-not $env:BRAIN_HEARTBEAT_MS){$env:BRAIN_HEARTBEAT_MS='5000'};if(-not $env:BRAIN_GLOBAL){$env:BRAIN_GLOBAL='1'};$env:BRAIN_STORE=$store
    if(-not $env:BRAIN_LEDGER){throw 'live start requires an explicit BRAIN_LEDGER'}
    if(-not $env:BRAIN_MAX_CALLS){throw 'live start requires BRAIN_MAX_CALLS'}
    if(-not $env:BRAIN_MAX_MICROS){throw 'live start requires BRAIN_MAX_MICROS'}
    if($env:QQ_CHAT_SCOPE -eq 'all'){Remove-Item Env:QQ_TEST_ONLY_OWNER -ErrorAction SilentlyContinue}
    elseif(-not $env:QQ_TEST_ONLY_OWNER){if(-not $env:QQ_OWNER){throw 'Set QQ_OWNER explicitly'};$env:QQ_TEST_ONLY_OWNER=$env:QQ_OWNER}
    if(-not $env:JY_TASK_THREADS){$env:JY_TASK_THREADS='1'};if(-not $env:JY_SUBJECTIVE_DOMAINS){$env:JY_SUBJECTIVE_DOMAINS='1'};if(-not $env:JY_SUBJECTIVE_MEMORY -and -not $env:JY_SUBJECTIVE_MEMORY_V2){$env:JY_SUBJECTIVE_MEMORY_V2='1'}
  } else {
    $env:BRAIN_LIVE='0';$env:BRAIN_HEARTBEAT_MS='0';if(-not $env:BRAIN_GLOBAL){$env:BRAIN_GLOBAL='1'};$env:BRAIN_STORE=$store
  }
  $p=StartHiddenNode $root (Join-Path $ops 'brain.out.log') (Join-Path $ops 'brain.err.log') 'tools/brain-service/run.mjs'
  WaitBrainReady $p.Id
  Set-Content $brainPidFile $p.Id
}

if($qqMode -and -not (PortOpen 3000)){
  $snow=Join-Path $root '..\SnowLuma\dist'
  $env:SNOWLUMA_DEV_WEBUI='1';$env:SNOWLUMA_HOOK_AUTOLOAD='1'
  $env:SNOWLUMA_LOG_DIR=Join-Path $ops 'snowluma-logs'
  $p=StartHiddenNode $snow (Join-Path $ops 'snowluma.out.log') (Join-Path $ops 'snowluma.err.log') 'index.mjs'
  Set-Content (Join-Path $ops 'snowluma.pid') $p.Id
  Start-Sleep -Seconds 12
} elseif($qqMode) {
  $snowRecord=Join-Path $ops 'snowluma.process.json'
  if(-not (Test-Path -LiteralPath $snowRecord)){throw 'port 3000 is occupied without our ownership record; not adopting that process'}
  AssertOwned snowluma
}

if($qqMode){
  if(-not $env:QQ_CONNECTOR_LOCK_ROOT){$env:QQ_CONNECTOR_LOCK_ROOT=Join-Path $ops 'connector-locks'}
  New-Item -ItemType Directory -Force -Path $env:QQ_CONNECTOR_LOCK_ROOT | Out-Null
  $connPidFile=Join-Path $ops 'connector.pid'
  $connId=0
  if(Test-Path $connPidFile){$connId=[int](Get-Content $connPidFile -Raw)}
  if(Alive $connId){AssertOwned connector}
  if(-not (Alive $connId)){
    $p=StartHiddenNode $root (Join-Path $ops 'connector.out.log') (Join-Path $ops 'connector.err.log') 'tools/qq-connect/bridge.mjs'
    Set-Content $connPidFile $p.Id
    Start-Sleep -Seconds 6
  }
}

$uiEntry=Join-Path $root 'tools/ui/server.mjs'
if(Test-Path -LiteralPath $uiEntry){
  $uiPidFile=Join-Path $ops 'ui.pid'
  $uiId=0
  if(Test-Path $uiPidFile){$uiId=[int](Get-Content $uiPidFile -Raw)}
  if(Alive $uiId){AssertOwned ui}
  if(-not (Alive $uiId)){
    $p=StartHiddenNode $root (Join-Path $ops 'ui.out.log') (Join-Path $ops 'ui.err.log') 'tools/ui/server.mjs'
    Set-Content $uiPidFile $p.Id
  }
}

try{$health=(Invoke-WebRequest 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 5).Content}catch{$health='brain not ready'}
Write-Host ('mode: ' + $(if($liveMode){'live'}else{'dry-run'}))
Write-Host ('qq: ' + $qqMode)
Write-Host ('health: ' + $health)
Write-Host ('logs: ' + $ops)
