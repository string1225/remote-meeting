param([switch]$LocalOnly)
$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
$meetingConfig = Get-Content -LiteralPath (Join-Path $meetingRoot '.local\host.json') -Raw | ConvertFrom-Json
$meetingHasher = [System.Security.Cryptography.SHA256]::Create()
try { $meetingSuffix = [BitConverter]::ToString($meetingHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($meetingRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $meetingHasher.Dispose() }
$meetingLock = [System.Threading.Mutex]::new($false, ('Local\RemoteMeetingHealthCheck-' + $meetingSuffix))
$meetingOwned = $false
try {
    try { $meetingOwned = $meetingLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $meetingOwned = $true }
    if (-not $meetingOwned) { exit 0 }
    Set-Location -LiteralPath $meetingRoot
    $meetingArguments = @((Join-Path $PSScriptRoot 'health-check.js'), '--repair')
    if ($LocalOnly) { $meetingArguments += '--local-only' }
    & $meetingConfig.nodePath @meetingArguments
    exit $LASTEXITCODE
} finally { if ($meetingOwned) { $meetingLock.ReleaseMutex() }; $meetingLock.Dispose() }
