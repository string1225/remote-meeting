param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$driverDirectory = Join-Path $repo '.local/independent-camera'
$deviceName = 'Remote Meeting Camera'
$category = '{860BB310-5D01-11D0-BD3B-00A0C911CE86}'
# Pin metadata: one output pin, MEDIATYPE_Video / MEDIASUBTYPE_NULL, MERIT_DO_NOT_USE.
$filterHex = '02000000000020000100000000000000307069330800000000000000010000000000000000000000307479330000000038000000480000007669647300001000800000AA00389B7100000000000000000000000000000000'
$filterData = [byte[]]@(for ($i = 0; $i -lt $filterHex.Length; $i += 2) { [Convert]::ToByte($filterHex.Substring($i, 2), 16) })
# Register for the current Windows user. OBS registration and Unity's default device are independent.
$sourceCommit = '3ed54c325e0ad71afcf4f246c07e5e17b3d7f2d2'
$hashes = @{32='AA3EBDF03DEA7F3AAB3DD7B724751F49ED71672256B57C6A19AA6809CABF30BA';64='72812F5363D8ECB45632253F8C8C888844B1B62E27616F3C8CC21064CCDE25E5'}
foreach ($bits in @(64,32)) {
  $view = if ($bits -eq 64) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
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
      if ($existing) { $root.DeleteSubKeyTree($instancePath, $false); $root.DeleteSubKeyTree($classPath, $false) }
      continue
    }
    New-Item -ItemType Directory -Path $driverDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'UnityCapture-LICENSE.txt') -Destination (Join-Path $driverDirectory 'LICENSE.txt') -Force
    $dll = Join-Path $driverDirectory ('UnityCaptureFilter' + $bits + '.dll')
    if (!(Test-Path -LiteralPath $dll)) {
      Invoke-WebRequest "https://raw.githubusercontent.com/schellingb/UnityCapture/$sourceCommit/Install/UnityCaptureFilter$bits.dll" -OutFile $dll
    }
    if ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $hashes[$bits]) { throw "Driver checksum mismatch ($bits bit)." }
    $key = $root.CreateSubKey($classPath)
    try { $key.SetValue('', $deviceName) } finally { $key.Dispose() }
    $key = $root.CreateSubKey($classPath + '\InprocServer32')
    try { $key.SetValue('', $dll); $key.SetValue('ThreadingModel', 'Both') } finally { $key.Dispose() }
    $key = $root.CreateSubKey($instancePath)
    try { $key.SetValue('CLSID', $clsid); $key.SetValue('FriendlyName', $deviceName); $key.SetValue('DevicePath', 'remote-meeting:camera-' + $bits); $key.SetValue('FilterData', $filterData, [Microsoft.Win32.RegistryValueKind]::Binary) } finally { $key.Dispose() }
  } finally { $root.Dispose() }
}
Write-Host $(if ($Uninstall) { 'Remote Meeting Camera unregistered for this Windows user.' } else { 'Remote Meeting Camera registered for this Windows user. Restart camera apps to refresh the device list.' })
