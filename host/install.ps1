param(
    [string]$ExtensionId = "legfpcfpmfannnifaiobenldancdgbdf",
    [string]$Python = ""
)
# Registers the native messaging host for Chrome-family browsers (HKCU only, no admin needed).
# Writes host.bat (with the Python found on this PC) and the host manifest next to this script.
$name = "com.plamo.translate_host"
if (-not $Python) {
    $cmd = Get-Command python.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1
    if ($cmd) { $Python = $cmd.Source }
}
if (-not $Python -or -not (Test-Path $Python)) { "Python 3 not found. Run again with -Python <path to python.exe>"; exit 1 }
$bat = Join-Path $PSScriptRoot "host.bat"
"@echo off`r`n`"$Python`" -I `"%~dp0host.py`" %*" | Set-Content -Encoding ascii $bat
"host.bat -> $Python"

$manifest = Join-Path $PSScriptRoot "$name.json"
@{
    name            = $name
    description     = "Starts and stops the local PLaMo 3 Translate server"
    path            = $bat
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json | Set-Content -Encoding ascii $manifest
foreach ($root in "HKCU:\Software\Google\Chrome", "HKCU:\Software\Vivaldi", "HKCU:\Software\Microsoft\Edge") {
    $key = "$root\NativeMessagingHosts\$name"
    New-Item -Force $key | Out-Null
    Set-Item $key -Value $manifest
    "registered: $key"
}
