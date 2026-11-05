param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
$meetingConfigFile = Join-Path $meetingRoot '.local\host.json'
if (-not (Test-Path -LiteralPath $meetingConfigFile)) { throw 'Create .local/host.json from host/config.example.json first.' }
$meetingConfig = Get-Content -LiteralPath $meetingConfigFile -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $meetingConfig.nodePath)) { throw 'Set nodePath to the installed Node.js executable.' }
$meetingStartup = [Environment]::GetFolderPath('Startup')
$meetingShell = New-Object -ComObject WScript.Shell
$meetingShortcut = $meetingShell.CreateShortcut((Join-Path $meetingStartup 'Remote Meeting Host.lnk'))
$meetingPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$meetingScript = Join-Path $PSScriptRoot 'run.ps1'
$meetingShortcut.TargetPath = $meetingPowerShell
$meetingShortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $meetingScript + '"'
$meetingShortcut.WorkingDirectory = $meetingRoot
$meetingShortcut.WindowStyle = 7
$meetingShortcut.Description = 'Remote Meeting host listener and local control window'
$meetingShortcut.Save()
Write-Output 'Host listener will start automatically after this Windows user signs in.'
if (-not $NoStart) { Start-Process -FilePath $meetingPowerShell -ArgumentList $meetingShortcut.Arguments -WorkingDirectory $meetingRoot -WindowStyle Hidden }
