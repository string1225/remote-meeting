[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('User', 'Machine')][string]$Scope = 'Machine', [switch]$Elevate, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$downloadDirectory = Join-Path $repo '.local/independent-camera'
$driverDirectory = if ($Scope -eq 'Machine') { Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Remote Meeting Camera' } else { $downloadDirectory }
$deviceName = 'Remote Meeting Camera'
$category = '{860BB310-5D01-11D0-BD3B-00A0C911CE86}'
# Pin metadata: one output pin, MEDIATYPE_Video / MEDIASUBTYPE_NULL, MERIT_DO_NOT_USE.
$filterHex = '02000000000020000100000000000000307069330800000000000000010000000000000000000000307479330000000038000000480000007669647300001000800000AA00389B7100000000000000000000000000000000'
$filterData = [byte[]]@(for ($i = 0; $i -lt $filterHex.Length; $i += 2) { [Convert]::ToByte($filterHex.Substring($i, 2), 16) })
# Machine registration supports capture clients that do not enumerate per-user filters.
# The dedicated slot is independent of OBS and Unity's default camera.
$sourceCommit = '3ed54c325e0ad71afcf4f246c07e5e17b3d7f2d2'
$hashes = @{32='AA3EBDF03DEA7F3AAB3DD7B724751F49ED71672256B57C6A19AA6809CABF30BA';64='72812F5363D8ECB45632253F8C8C888844B1B62E27616F3C8CC21064CCDE25E5'}
$administrator = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Scope -eq 'Machine' -and !$administrator -and !$WhatIfPreference) {
  if (!$Elevate) { throw 'Machine registration requires Windows administrator approval. Run this script with -Elevate, or use -WhatIf to review the plan.' }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Scope Machine'
  if ($Uninstall) { $arguments += ' -Uninstall' }
  $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw ('Machine driver setup failed: ' + $process.ExitCode) }
  return
}
$hive = if ($Scope -eq 'Machine') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
foreach ($bits in @(64,32)) {
  $view = if ($bits -eq 64) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
  try {
    $suffix = if ($bits -eq 64) { '12' } else { '22' }
    $clsid = '{5C2CD55C-92AD-4999-8666-912BD3E700' + $suffix + '}'
    $classPath = 'Software\Classes\CLSID\' + $clsid
    $instancePath = 'Software\Classes\CLSID\' + $category + '\Instance\' + $clsid
    $existing = $root.OpenSubKey($classPath)
    $merged = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, $view)
    try {
      $registered = $merged.OpenSubKey('CLSID\' + $clsid)
      if ($registered) { try { if ($registered.GetValue('') -ne $deviceName) { throw "Device slot belongs to another application ($bits bit)." } } finally { $registered.Dispose() } }
    } finally { $merged.Dispose() }
    if ($existing) {
      try { if ($existing.GetValue('') -ne $deviceName) { throw "Device slot is already registered by another application ($bits bit)." } }
      finally { $existing.Dispose() }
    }
    if ($Uninstall) {
      if ($existing -and $PSCmdlet.ShouldProcess("$hive $view $clsid", 'Unregister Remote Meeting Camera')) { $root.DeleteSubKeyTree($instancePath, $false); $root.DeleteSubKeyTree($classPath, $false) }
      continue
    }
    if (!$PSCmdlet.ShouldProcess("$hive $view $clsid -> $driverDirectory", 'Install dedicated Remote Meeting Camera driver')) { continue }
    New-Item -ItemType Directory -Path $driverDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'UnityCapture-LICENSE.txt') -Destination (Join-Path $driverDirectory 'LICENSE.txt') -Force
    $download = Join-Path $downloadDirectory ('UnityCaptureFilter' + $bits + '.dll')
    if (!(Test-Path -LiteralPath $download)) {
      Invoke-WebRequest "https://raw.githubusercontent.com/schellingb/UnityCapture/$sourceCommit/Install/UnityCaptureFilter$bits.dll" -OutFile $download
    }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $hashes[$bits]) { throw "Driver checksum mismatch ($bits bit)." }
    $dll = Join-Path $driverDirectory ('UnityCaptureFilter' + $bits + '.dll')
    if ($dll -ne $download -and (!(Test-Path -LiteralPath $dll) -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $hashes[$bits])) { Copy-Item -LiteralPath $download -Destination $dll -Force }
    $key = $root.CreateSubKey($classPath)
    try { $key.SetValue('', $deviceName) } finally { $key.Dispose() }
    $key = $root.CreateSubKey($classPath + '\InprocServer32')
    try { $key.SetValue('', $dll); $key.SetValue('ThreadingModel', 'Both') } finally { $key.Dispose() }
    $key = $root.CreateSubKey($instancePath)
    # Omit an invented DevicePath. Clients can use the standard DirectShow moniker,
    # as with OBS's software camera, instead of treating a fake hardware path as a device.
    try { $key.SetValue('CLSID', $clsid); $key.SetValue('FriendlyName', $deviceName); $key.DeleteValue('DevicePath', $false); $key.SetValue('FilterData', $filterData, [Microsoft.Win32.RegistryValueKind]::Binary) } finally { $key.Dispose() }
  } finally { $root.Dispose() }
}
if ($WhatIfPreference) { return }
if ($Scope -eq 'Machine' -and !$Uninstall) {
  # Remove only our obsolete per-user entries after both machine views are installed.
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $suffix = if ($view -eq [Microsoft.Win32.RegistryView]::Registry64) { '12' } else { '22' }
      $clsid = '{5C2CD55C-92AD-4999-8666-912BD3E700' + $suffix + '}'
      $classPath = 'Software\Classes\CLSID\' + $clsid
      $key = $root.OpenSubKey($classPath)
      if ($key) {
        try { $owned = $key.GetValue('') -eq $deviceName } finally { $key.Dispose() }
        if ($owned) {
          $root.DeleteSubKeyTree('Software\Classes\CLSID\' + $category + '\Instance\' + $clsid, $false); $root.DeleteSubKeyTree($classPath, $false)
          # Empty user category keys can shadow the corresponding machine category.
          foreach ($path in @('Software\Classes\CLSID\' + $category + '\Instance', 'Software\Classes\CLSID\' + $category)) {
            $empty = $root.OpenSubKey($path)
            if ($empty) {
              try { $removeEmpty = $empty.SubKeyCount -eq 0 -and $empty.ValueCount -eq 0 } finally { $empty.Dispose() }
              if ($removeEmpty) { $root.DeleteSubKey($path, $false) }
            }
          }
        }
      }
    } finally { $root.Dispose() }
  }
}
Write-Host $(if ($Uninstall) { "Remote Meeting Camera unregistered ($Scope)." } else { "Remote Meeting Camera registered ($Scope). Reopen camera settings in your meeting app to refresh its device list." })
