param([switch]$NoStart)
# Checks that this checkout is ready to use: config, llama-server build, models, Python,
# native host registration, and one real translation. Prints OK/NG per item; exit code = number of NG.
$root = Split-Path $PSScriptRoot -Parent
$ng = 0
function Report([bool]$ok, [string]$item, [string]$detail) {
    $mark = if ($ok) { "OK" } else { "NG" }
    "[$mark] $item - $detail"
    if (-not $ok) { $script:ng++ }
}

# 1. config.json
$cfgPath = Join-Path $PSScriptRoot "config.json"
$cfg = $null
if (Test-Path $cfgPath) {
    try { $cfg = Get-Content -Raw -Encoding utf8 $cfgPath | ConvertFrom-Json } catch {}
}
Report ($null -ne $cfg) "config" $(if ($cfg) { $cfgPath } else { "server\config.json missing or invalid (copy config.example.json)" })
$port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 11437 }

# 2. llama-server and its build number (PLaMo 3 needs b11946+)
$exe = if ($cfg) { $cfg.llamaServer } else { $null }
if ($exe -and (Test-Path $exe)) {
    $ver = (& $exe --version 2>&1 | Out-String)
    $build = if ($ver -match "build (\d+)") { [int]$Matches[1] } else { 0 }
    Report ($build -ge 11946) "llama-server" "$exe (build $build, need 11946+)"
} else {
    Report $false "llama-server" "not found: $exe"
}

# 3. models
$models = @()
if ($cfg -and $cfg.modelDir -and (Test-Path $cfg.modelDir)) {
    $models = @(Get-ChildItem $cfg.modelDir -Filter "plamo-3-translate-*-Q4_K_M.gguf" | ForEach-Object Name)
}
Report ($models -contains "plamo-3-translate-2b-Q4_K_M.gguf") "model 2b" $(if ($models) { $models -join ", " } else { "no plamo-3-translate-*-Q4_K_M.gguf in modelDir" })

# 4. native messaging host (host.bat -> Python, registry -> this checkout)
$bat = Join-Path $root "host\host.bat"
$py = if (Test-Path $bat) { if ((Get-Content $bat -Raw) -match '"([^"]+python[^"]*\.exe)"') { $Matches[1] } } else { $null }
Report ([bool]($py -and (Test-Path $py))) "host.bat" $(if ($py) { $py } else { "missing: run host\install.ps1" })
$manifest = Join-Path $root "host\com.plamo.translate_host.json"
$anyReg = $false
foreach ($b in "Google\Chrome", "Vivaldi", "Microsoft\Edge") {
    $key = "HKCU:\Software\$b\NativeMessagingHosts\com.plamo.translate_host"
    $val = if (Test-Path $key) { (Get-Item $key).GetValue("") } else { $null }
    if ($val -and ($val -eq $manifest)) { "[OK] registry $b"; $anyReg = $true }
    elseif ($val) { "[--] registry $b - points to another checkout: $val (run host\install.ps1 here)" }
    else { "[--] registry $b - not registered" }
}
Report $anyReg "registry" "at least one browser points to $manifest"

# 5. server + one translation
if (-not $NoStart -and $ng -eq 0) {
    $out = & (Join-Path $PSScriptRoot "start-plamo.ps1") -Size 2b
    Report ($LASTEXITCODE -eq 0 -or "$out" -match "up") "server" "$out"
    try {
        $body = @{ model = "plamo"; temperature = 0; max_tokens = 64
                   messages = @(@{ role = "user"; content = "The weather is nice today." })
                   chat_template_kwargs = @{ target_lang = "ja" } } | ConvertTo-Json -Depth 5
        $r = Invoke-RestMethod "http://127.0.0.1:$port/v1/chat/completions" -Method Post -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
        $text = $r.choices[0].message.content
        Report ($text -match "[぀-ヿ一-鿿]") "translate" "en->ja returned $($text.Length) chars"
    } catch {
        Report $false "translate" "$_"
    }
} elseif ($NoStart) {
    "[--] server - skipped (-NoStart)"
} else {
    "[--] server - skipped (fix the NG items first)"
}
""
if ($ng -eq 0) { "READY" } else { "NOT READY ($ng NG)" }
exit $ng
