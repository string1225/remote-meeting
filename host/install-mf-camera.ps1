[CmdletBinding(SupportsShouldProcess)]
param([switch]$Elevate, [switch]$InstallComponents, [string]$OwnerSid)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$build=Join-Path $repo '.local/mf-camera/bin'
$source=Join-Path $build 'RemoteMeetingMediaSource.dll'
$controller=Join-Path $build 'RemoteMeetingCamera.exe'
if(!(Test-Path -LiteralPath $source) -or !(Test-Path -LiteralPath $controller)){throw 'Build the native component with host/build-mf-camera.ps1 first.'}
$clsid='{4F22DDB6-C706-4DC9-AE89-7C9D29B66241}'
$administrator=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if(!$OwnerSid){$OwnerSid=$currentSid}
$sid=[Security.Principal.SecurityIdentifier]::new($OwnerSid)
if($InstallComponents){
  Start-Transcript -Path (Join-Path $repo '.local/mf-camera/install.log') -Force | Out-Null
  if(!$administrator){throw 'Installing the Frame Server component requires Windows administrator approval.'}
  $version=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0,12).ToLower()
  $directory=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('Remote Meeting Camera/native/'+$version)
  $frames=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote Meeting Camera'
  if(!$PSCmdlet.ShouldProcess($directory,'Install native Media Foundation source and private frame transport')){return}
  New-Item -ItemType Directory -Path $directory,$frames -Force | Out-Null
  $installedDll=Join-Path $directory 'RemoteMeetingMediaSource.dll'
  $installedController=Join-Path $directory 'RemoteMeetingCamera.exe'
  foreach($pair in @(@($source,$installedDll),@($controller,$installedController))){
    if(!(Test-Path -LiteralPath $pair[1]) -or (Get-FileHash -LiteralPath $pair[0]).Hash -ne (Get-FileHash -LiteralPath $pair[1]).Hash){Copy-Item -LiteralPath $pair[0] -Destination $pair[1] -Force}
  }
  # Frames are private to the desktop owner and Windows Frame Server services.
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  foreach($entry in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($OwnerSid,'Modify'),@('S-1-5-19','ReadAndExecute'))){
    $identity=[Security.Principal.SecurityIdentifier]::new($entry[0])
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]$entry[1],[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $frames -AclObject $acl
  $framePath=Join-Path $frames 'latest-frame.nv12'
  if(!(Test-Path -LiteralPath $framePath)){
    $file=[IO.File]::Open($framePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
    try{$file.SetLength(64+1920*1080*3/2)}finally{$file.Dispose()}
  }elseif((Get-Item -LiteralPath $framePath).Length -ne 64+1920*1080*3/2){throw 'Existing frame transport has an unexpected size.'}
  $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $previousDll=$null
  try{
    $classPath='Software\Classes\CLSID\'+$clsid
    $old=$root.OpenSubKey($classPath)
    if($old){try{if($old.GetValue('') -ne 'Remote Meeting Camera Media Foundation Source'){throw 'Native media source CLSID belongs to another application.'}}finally{$old.Dispose()}}
    $oldServer=$root.OpenSubKey($classPath+'\InprocServer32')
    if($oldServer){try{$previousDll=$oldServer.GetValue('')}finally{$oldServer.Dispose()}}
    $key=$root.CreateSubKey($classPath);try{$key.SetValue('','Remote Meeting Camera Media Foundation Source')}finally{$key.Dispose()}
    $key=$root.CreateSubKey($classPath+'\InprocServer32');try{$key.SetValue('',$installedDll);$key.SetValue('ThreadingModel','Both')}finally{$key.Dispose()}
    $key=$root.CreateSubKey('SOFTWARE\RemoteMeetingCamera')
    try{$key.SetValue('ControllerPath',$installedController);$key.SetValue('DllPath',$installedDll);$key.SetValue('FramePath',$framePath);$key.SetValue('OwnerSid',$OwnerSid)}finally{$key.Dispose()}
  }finally{$root.Dispose()}
  # COM can retain the old DLL in Frame Server after its registry path changes.
  # Refresh only when upgrading an already registered media source.
  if($previousDll -and $previousDll -ne $installedDll){
    $frameServer=Get-Service -Name FrameServer -ErrorAction SilentlyContinue
    if($frameServer -and $frameServer.Status -eq 'Running'){
      Restart-Service -Name FrameServer -Force
      Write-Output 'Windows Frame Server refreshed for the media source update.'
    }
  }
  Write-Output 'Native Frame Server component installed.'
  return
}
# Validate source behavior before asking Windows for installation permission.
& $controller self-test $source
if($LASTEXITCODE -ne 0){throw 'Native media source self-test failed.'}
if($WhatIfPreference){Write-Output 'Plan: install x64 media source under Program Files, register its dedicated CLSID, create private frame transport, then publish a current-user Windows virtual camera.';return}
if(!$PSCmdlet.ShouldProcess('Remote Meeting Camera','Install and publish Windows native virtual camera')){return}
if(!$administrator){
  if(!$Elevate){throw 'Run this script with -Elevate to request Windows administrator approval.'}
  $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -InstallComponents -OwnerSid '+$OwnerSid
  $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if($process.ExitCode -ne 0){throw ('Native component installation failed: '+$process.ExitCode)}
}else{& $PSCommandPath -InstallComponents -OwnerSid $OwnerSid}
# Publish from the original desktop account, including when UAC used another admin.
& $controller publish
if($LASTEXITCODE -ne 0){throw 'Native camera publication failed. The previous camera registrations have been preserved.'}
# Remove only our old per-user UnityCapture registration after native publication succeeds.
$category='{860BB310-5D01-11D0-BD3B-00A0C911CE86}'
foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){
  $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  try{
    $suffix=if($view -eq [Microsoft.Win32.RegistryView]::Registry64){'12'}else{'22'}
    $legacy='{5C2CD55C-92AD-4999-8666-912BD3E700'+$suffix+'}'
    $classPath='Software\Classes\CLSID\'+$legacy
    $key=$root.OpenSubKey($classPath)
    if($key){
      try{$owned=$key.GetValue('') -eq 'Remote Meeting Camera'}finally{$key.Dispose()}
      if($owned){
        $root.DeleteSubKeyTree('Software\Classes\CLSID\'+$category+'\Instance\'+$legacy,$false);$root.DeleteSubKeyTree($classPath,$false)
        foreach($path in @('Software\Classes\CLSID\'+$category+'\Instance','Software\Classes\CLSID\'+$category)){
          $key=$root.OpenSubKey($path)
          if($key){try{$empty=$key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0}finally{$key.Dispose()};if($empty){$root.DeleteSubKey($path,$false)}}
        }
      }
    }
  }finally{$root.Dispose()}
}
Write-Output 'Ready. Reopen camera settings and choose the Remote Meeting Camera Windows virtual-camera device (suffix follows the Windows language).'
