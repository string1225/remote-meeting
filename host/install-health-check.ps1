$ErrorActionPreference = 'Stop'
$meetingRoot = Split-Path -Parent $PSScriptRoot
$meetingPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$meetingRunner = Join-Path $PSScriptRoot 'health-check-runner.ps1'
if (-not (Test-Path -LiteralPath $meetingRunner)) { throw 'Health-check runner is missing.' }
$meetingIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($meetingIdentity.User.Value -in @('S-1-5-18','S-1-5-19','S-1-5-20')) {
    throw 'Run this installer as the signed-in desktop user. A scheduled service-account token cannot read this user-profile project.'
}
$meetingPrincipal = New-ScheduledTaskPrincipal -UserId $meetingIdentity.Name -LogonType Interactive
$meetingSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 1)
function Install-MeetingTask($name, $arguments, $triggers, $settings) {
    $meetingExisting = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($meetingExisting -and $meetingExisting.Actions.Arguments -notmatch [regex]::Escape($meetingRoot)) { throw ('Unrelated task uses name ' + $name) }
    # The runner selects its own absolute project root. Let Task Scheduler use
    # its default system directory instead of resolving a user-profile cwd.
    $meetingAction = New-ScheduledTaskAction -Execute $meetingPowerShell -Argument $arguments
    Register-ScheduledTask -TaskName $name -Action $meetingAction -Trigger $triggers -Principal $meetingPrincipal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $meetingRoot ('.local\' + $name + '.xml')) -Encoding UTF8
}
$meetingBaseArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $meetingRunner + '"'
$meetingDaily = @((New-ScheduledTaskTrigger -Daily -At '17:15'), (New-ScheduledTaskTrigger -Daily -At '17:30'))
Install-MeetingTask 'RemoteMeeting-Health-Recovery' $meetingBaseArguments $meetingDaily $meetingSettings
# A minute watchdog covers Modern Standby recovery and missing supervisors.
# It does not wake the computer each minute; daily full checks may wake it.
$meetingGuardTrigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$meetingGuardTrigger.Repetition = New-CimInstance -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskRepetitionPattern -ClientOnly -Property @{ Interval='PT1M'; Duration='P1D'; StopAtDurationEnd=$false }
$meetingGuardSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Install-MeetingTask 'RemoteMeeting-Wake-Guard' ($meetingBaseArguments + ' -LocalOnly') @($meetingGuardTrigger) $meetingGuardSettings
$meetingSummary = [pscustomobject]@{ DailyTask='RemoteMeeting-Health-Recovery'; DailyTimes=@('17:15','17:30'); Timezone=[TimeZoneInfo]::Local.Id; Principal=$meetingIdentity.Name; GuardTask='RemoteMeeting-Wake-Guard'; GuardIntervalSeconds=60; DailyNextRun=(Get-ScheduledTaskInfo -TaskName 'RemoteMeeting-Health-Recovery').NextRunTime.ToString('yyyy-MM-dd HH:mm:ss zzz'); GuardNextRun=(Get-ScheduledTaskInfo -TaskName 'RemoteMeeting-Wake-Guard').NextRunTime.ToString('yyyy-MM-dd HH:mm:ss zzz') }
$meetingSummary | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $meetingRoot '.local\health-check-install.json') -Encoding UTF8
$meetingSummary | ConvertTo-Json -Compress
