$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
$meetingConfig = Get-Content -LiteralPath (Join-Path $meetingRoot '.local\host.json') -Raw | ConvertFrom-Json
$meetingPort = if ($meetingConfig.port) { [int]$meetingConfig.port } else { 3034 }
$meetingListener = @(Get-NetTCPConnection -LocalPort $meetingPort -State Listen -ErrorAction SilentlyContinue)
if ($meetingListener.Count -gt 1) { throw 'More than one host listener was found.' }
if ($meetingListener.Count -eq 1) {
    $meetingProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $meetingListener[0].OwningProcess)
    if ($meetingProcess.Name -ne 'node.exe' -or $meetingProcess.CommandLine -notmatch 'host[/\\]index\.js') {
        throw 'Cannot verify the host process. Run this script as the signed-in desktop user.'
    }
    $meetingSupervisor = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $meetingProcess.ParentProcessId)
    $meetingStopId = $meetingProcess.ProcessId
    if ($meetingSupervisor.Name -eq 'powershell.exe' -and $meetingSupervisor.CommandLine -match [regex]::Escape((Join-Path $PSScriptRoot 'run.ps1'))) {
        $meetingStopId = $meetingSupervisor.ProcessId
    }
    & taskkill.exe /PID $meetingStopId /T /F
    if ($LASTEXITCODE -ne 0) { throw 'Windows refused to stop the host. Run this script as the signed-in desktop user.' }
}
$meetingPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$meetingRun = Join-Path $PSScriptRoot 'run.ps1'
Start-Process -FilePath $meetingPowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $meetingRun + '"')) -WorkingDirectory $meetingRoot -WindowStyle Hidden
for ($meetingAttempt = 0; $meetingAttempt -lt 30; $meetingAttempt++) {
    Start-Sleep -Seconds 1
    try {
        $meetingStatus = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $meetingPort + '/api/status') -TimeoutSec 2
        if ($meetingStatus.online -and $meetingStatus.renderer) {
            Write-Output 'Meeting host restarted and connected.'
            exit 0
        }
    } catch { }
}
throw 'The host did not reconnect within 30 seconds. Check .local/host.log.'
