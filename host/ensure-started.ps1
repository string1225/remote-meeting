$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
$meetingPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$meetingRun = Join-Path $PSScriptRoot 'run.ps1'
Start-Process -FilePath $meetingPowerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $meetingRun + '"')) -WorkingDirectory $meetingRoot -WindowStyle Hidden
Write-Output 'Meeting startup guard requested.'
