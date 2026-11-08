param([int]$Port = 11437)
# Stops the llama-server that start-plamo.ps1 started (matched by its port).
$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" |
    Where-Object { $_.CommandLine -match "--port\s+$Port\b" })
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force }
"stopped $($procs.Count)"
