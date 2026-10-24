$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $meetingRoot
$meetingConfig = Get-Content -LiteralPath (Join-Path $meetingRoot '.local\host.json') -Raw | ConvertFrom-Json
$meetingNode = $meetingConfig.nodePath
if (-not $meetingNode -or -not (Test-Path -LiteralPath $meetingNode)) {
    $meetingNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $meetingNodeCommand) { throw 'Node.js 22+ was not found. Install Node.js or update nodePath in .local/host.json.' }
    $meetingNode = $meetingNodeCommand.Source
}
# One supervisor per desktop user. It owns only its own host process.
$meetingMutex = [System.Threading.Mutex]::new($false, 'Local\RemoteMeetingHostSupervisor')
if (-not $meetingMutex.WaitOne(0)) { exit 0 }
try {
    while ($true) {
        $meetingProcess = Start-Process -FilePath $meetingNode -ArgumentList 'host/index.js' -WorkingDirectory $meetingRoot -WindowStyle Hidden -PassThru
        $meetingProcess.WaitForExit()
        Start-Sleep -Seconds 5
    }
} finally { $meetingMutex.ReleaseMutex(); $meetingMutex.Dispose() }
