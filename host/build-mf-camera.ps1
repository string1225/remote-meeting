param([string]$ToolchainRoot = '.local/mf-camera-development/toolchain')
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
$toolchain=if(Test-Path -LiteralPath $ToolchainRoot){(Resolve-Path -LiteralPath $ToolchainRoot).Path}else{$null}
$compiler=if($toolchain){Get-ChildItem -LiteralPath $toolchain -Filter cl.exe -Recurse -File | Where-Object FullName -match 'Hostx64\\x64\\cl.exe$' | Select-Object -First 1}else{
  $command=Get-Command cl.exe -ErrorAction SilentlyContinue
  if($command){Get-Item -LiteralPath $command.Source}
}
if(!$compiler){throw 'An x64 MSVC toolchain is required.'}
$vc=Split-Path (Split-Path (Split-Path (Split-Path $compiler.FullName -Parent) -Parent) -Parent) -Parent
$sdkSearch=if($toolchain){$toolchain}else{
  $kits=Get-ItemProperty -LiteralPath 'HKLM:/SOFTWARE/Microsoft/Windows Kits/Installed Roots' -ErrorAction SilentlyContinue
  if($kits.KitsRoot10){Join-Path $kits.KitsRoot10 'Include'}
}
$sdkHeader=if($sdkSearch){Get-ChildItem -LiteralPath $sdkSearch -Filter mfvirtualcamera.h -Recurse -File | Sort-Object FullName -Descending | Select-Object -First 1}
if(!$sdkHeader){throw 'Windows SDK 22000+ is required.'}
$includeRoot=Split-Path (Split-Path $sdkHeader.FullName -Parent) -Parent
$sdkVersion=Split-Path $includeRoot -Leaf
$sdkRoot=Split-Path (Split-Path $includeRoot -Parent) -Parent
$includes=@((Join-Path $vc 'include'),(Join-Path $includeRoot 'ucrt'),(Join-Path $includeRoot 'shared'),(Join-Path $includeRoot 'um'),(Join-Path $includeRoot 'winrt'))
$libs=@((Join-Path $vc 'lib/x64'),(Join-Path $sdkRoot ('Lib/'+$sdkVersion+'/um/x64')),(Join-Path $sdkRoot ('Lib/'+$sdkVersion+'/ucrt/x64')))
$oldIncludes=$env:INCLUDE;$oldLibs=$env:LIB;$oldPath=$env:PATH
$output=Join-Path $repo '.local/mf-camera/bin'
New-Item -ItemType Directory -Path $output -Force | Out-Null
try {
  $env:INCLUDE=$includes -join ';';$env:LIB=$libs -join ';';$env:PATH=$compiler.DirectoryName+';'+$oldPath
  $common=@('/nologo','/std:c++17','/O2','/MT','/EHsc','/W4','/DUNICODE','/D_UNICODE','/DWIN32_LEAN_AND_MEAN','/D_WIN32_WINNT=0x0A00')
  Push-Location -LiteralPath $output
  try {
    & $compiler.FullName @common /LD (Join-Path $PSScriptRoot 'mf-camera/source.cpp') /link ('/DEF:'+(Join-Path $PSScriptRoot 'mf-camera/source.def')) /OUT:RemoteMeetingMediaSource.dll mfplat.lib mf.lib mfuuid.lib ole32.lib oleaut32.lib advapi32.lib propsys.lib uuid.lib ksuser.lib
    if($LASTEXITCODE -ne 0){throw 'Media source build failed.'}
    & $compiler.FullName @common (Join-Path $PSScriptRoot 'mf-camera/control.cpp') /link /OUT:RemoteMeetingCamera.exe mfplat.lib mf.lib mfuuid.lib mfsensorgroup.lib ole32.lib oleaut32.lib advapi32.lib propsys.lib uuid.lib
    if($LASTEXITCODE -ne 0){throw 'Camera controller build failed.'}
  } finally {Pop-Location}
} finally {$env:INCLUDE=$oldIncludes;$env:LIB=$oldLibs;$env:PATH=$oldPath}
Write-Output ('Built native virtual camera: '+$output)
