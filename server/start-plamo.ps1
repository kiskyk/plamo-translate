param([ValidateSet("0.8b", "2b", "8b")][string]$Size = "2b", [int]$Port = 11437)
# Starts llama-server with PLaMo 3 Translate. Paths come from config.json next to this script
# (copy config.example.json). Needs llama.cpp b11946 or later (plamo3 tokenizer).
$cfgPath = Join-Path $PSScriptRoot "config.json"
if (-not (Test-Path $cfgPath)) { "config.json not found: copy server\config.example.json to server\config.json and edit it"; exit 1 }
$cfg = Get-Content -Raw -Encoding utf8 $cfgPath | ConvertFrom-Json
$exe = $cfg.llamaServer
if (-not $exe -or -not (Test-Path $exe)) { "llama-server not found: $exe (set llamaServer in config.json)"; exit 1 }
$model = Join-Path $cfg.modelDir "plamo-3-translate-$Size-Q4_K_M.gguf"
if (-not (Test-Path $model)) { "model not found: $model (set modelDir in config.json)"; exit 1 }

try {
    $p = Invoke-RestMethod "http://127.0.0.1:$Port/props" -TimeoutSec 2
    if ($p.model_path -like "*$Size-Q4_K_M*") { "already up ($Size)"; exit 0 }
    & "$PSScriptRoot\stop-plamo.ps1" -Port $Port | Out-Null
} catch {}

$logDir = if ($cfg.logDir) { $cfg.logDir } else { Join-Path $PSScriptRoot "logs" }
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "plamo_server_$Size"
$ngl = if ($null -ne $cfg.gpuLayers) { $cfg.gpuLayers } else { 99 }
$ctx = if ($cfg.context) { $cfg.context } else { 16384 }
$np = if ($cfg.parallel) { $cfg.parallel } else { 4 }
# Launched through WMI, not Start-Process: Start-Process lets llama-server inherit the caller's
# stdout pipe, so whoever captures this script's output would wait until the server exits.
$args_ = "-m `"$model`" --alias plamo --port $Port --host 127.0.0.1 -ngl $ngl -c $ctx -np $np --jinja --no-prefill-assistant"
$cmdline = "cmd.exe /c `"`"$exe`" $args_ > `"$log.log`" 2> `"$log.err`"`""
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline; ProcessStartupInformation = $startup }
if ($r.ReturnValue -ne 0) { "failed to launch llama-server (Win32_Process.Create returned $($r.ReturnValue))"; exit 1 }
foreach ($i in 1..60) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; "up ($Size, port $Port)"; exit 0 } catch { Start-Sleep 1 }
}
"failed (see $log.err)"; exit 1
