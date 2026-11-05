param(
    [ValidateRange(1, 300)][int]$HealthCheckSeconds = 10,
    [ValidateRange(1, 300)][int]$RestartDelaySeconds = 5,
    [ValidateRange(1, 20)][int]$HealthFailureLimit = 3
)
$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $meetingRoot
$meetingLocal = Join-Path $meetingRoot '.local'
New-Item -ItemType Directory -Path $meetingLocal -Force | Out-Null
$meetingLog = Join-Path $meetingLocal 'supervisor.log'
function Write-MeetingLog([string]$message) {
    try {
        if ((Test-Path -LiteralPath $meetingLog) -and (Get-Item -LiteralPath $meetingLog).Length -gt 2097152) {
            Move-Item -LiteralPath $meetingLog -Destination ($meetingLog + '.previous') -Force
        }
        Add-Content -LiteralPath $meetingLog -Encoding UTF8 -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message)
    } catch { Write-Warning 'Unable to write meeting supervisor log.' }
}
function Read-MeetingStatus([int]$port) {
    try {
        $meetingResponse = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/status') -TimeoutSec 2
        # Accept an existing older host as well, so an upgrade or another user
        # session does not start competing listeners or kill somebody else's host.
        if ($meetingResponse.service -eq 'remote-meeting-host' -or
            ($null -ne $meetingResponse.output -and $null -ne $meetingResponse.renderer -and $null -ne $meetingResponse.online)) {
            return $meetingResponse
        }
    } catch { }
    return $null
}
# Scope the lock to this installation and Windows session. Recover an abandoned
# lock after an unexpected supervisor exit instead of abandoning login startup.
$meetingHash = [System.Security.Cryptography.SHA256]::Create()
try { $meetingInstance = [BitConverter]::ToString($meetingHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($meetingRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $meetingHash.Dispose() }
$meetingMutex = [System.Threading.Mutex]::new($false, ('Local\RemoteMeetingHostSupervisor-' + $meetingInstance))
$meetingAcquired = $false
$meetingProcess = $null
try {
    try { $meetingAcquired = $meetingMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $meetingAcquired = $true }
    if (-not $meetingAcquired) { Write-MeetingLog 'Another supervisor already owns this installation in this session.'; exit 0 }
    $meetingIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-MeetingLog ('Supervisor started; user=' + $meetingIdentity + '; session=' + [System.Diagnostics.Process]::GetCurrentProcess().SessionId)
    if ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -notin @('S-1-5-18','S-1-5-19','S-1-5-20') -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'install-health-check.ps1'))) {
        try { & (Join-Path $PSScriptRoot 'install-health-check.ps1') | Out-Null; Write-MeetingLog 'Daily health checks and minute wake guard registered for the desktop user.' }
        catch { Write-MeetingLog ('Health task registration failed: ' + $_.Exception.Message) }
    }
    $meetingFailures = 0
    $meetingLastState = ''
    while ($true) {
        try {
            if ($meetingProcess -and $meetingProcess.HasExited) {
                $meetingProcess.WaitForExit()
                Write-MeetingLog ('Host exited; pid=' + $meetingProcess.Id + '; exitCode=' + $meetingProcess.ExitCode)
                $meetingProcess.Dispose(); $meetingProcess = $null
                Start-Sleep -Seconds $RestartDelaySeconds
            }
            if (-not $meetingProcess) {
                # Retry config/runtime/start failures after login; network and
                # user-profile startup ordering must not permanently end the guard.
                $meetingConfig = Get-Content -LiteralPath (Join-Path $meetingLocal 'host.json') -Raw | ConvertFrom-Json
                $meetingPort = if ($meetingConfig.port) { [int]$meetingConfig.port } else { 3034 }
                $meetingExisting = Read-MeetingStatus $meetingPort
                if ($meetingExisting) {
                    if ($meetingLastState -ne 'existing') { Write-MeetingLog 'Existing host found; monitoring without launching a duplicate.'; $meetingLastState = 'existing' }
                    Start-Sleep -Seconds $HealthCheckSeconds
                    continue
                }
                $meetingNode = $meetingConfig.nodePath
                if (-not $meetingNode -or -not (Test-Path -LiteralPath $meetingNode)) {
                    $meetingNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
                    if (-not $meetingNodeCommand) { throw 'Node.js 22+ was not found. Check nodePath in .local/host.json.' }
                    $meetingNode = $meetingNodeCommand.Source
                }
                $env:HOST_CONFIG = Join-Path $meetingLocal 'host.json'
                foreach ($meetingOutputName in @('host-process.log', 'host-process-error.log')) {
                    $meetingOutput = Join-Path $meetingLocal $meetingOutputName
                    if (Test-Path -LiteralPath $meetingOutput) { Move-Item -LiteralPath $meetingOutput -Destination ($meetingOutput + '.previous') -Force }
                }
                $meetingProcess = Start-Process -FilePath $meetingNode -ArgumentList 'host/index.js' -WorkingDirectory $meetingRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $meetingLocal 'host-process.log') -RedirectStandardError (Join-Path $meetingLocal 'host-process-error.log')
                # Keep the process handle while it is alive. Without this,
                # Windows PowerShell can lose ExitCode after a quick crash.
                $null = $meetingProcess.Handle
                Write-MeetingLog ('Host launched; pid=' + $meetingProcess.Id)
                $meetingFailures = 0; $meetingLastState = ''
                Start-Sleep -Seconds $HealthCheckSeconds
                continue
            }
            $meetingStatus = Read-MeetingStatus $meetingPort
            if ($meetingStatus) {
                $meetingFailures = 0
                $meetingState = 'online=' + $meetingStatus.online + '; renderer=' + $meetingStatus.renderer
                if ($meetingState -ne $meetingLastState) { Write-MeetingLog ('Host status: ' + $meetingState); $meetingLastState = $meetingState }
                # Cloud outages use the host's heartbeat/reconnect logic; they do
                # not trigger a process restart or repeated device interruption.
            } else {
                $meetingFailures++
                Write-MeetingLog ('Local health check failed; consecutive=' + $meetingFailures)
                if ($meetingFailures -ge $HealthFailureLimit -and -not $meetingProcess.HasExited) {
                    Write-MeetingLog ('Restarting unresponsive owned host; pid=' + $meetingProcess.Id)
                    & taskkill.exe /PID $meetingProcess.Id /T /F | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw 'Windows refused to stop the owned host process.' }
                    [void]$meetingProcess.WaitForExit(5000)
                }
            }
            Start-Sleep -Seconds $HealthCheckSeconds
        } catch {
            Write-MeetingLog ('Supervisor retry: ' + $_.Exception.Message)
            Start-Sleep -Seconds $RestartDelaySeconds
        }
    }
} finally {
    Write-MeetingLog 'Supervisor stopped.'
    if ($meetingAcquired) { $meetingMutex.ReleaseMutex() }
    $meetingMutex.Dispose()
}
