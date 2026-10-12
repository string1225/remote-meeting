param([string]$PythonPath = 'python')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
& $PythonPath -m venv .local/virtual-camera
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required' }
& '.local/virtual-camera/Scripts/python.exe' -m pip install -r host/virtual-camera-requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Virtual camera dependencies could not be installed' }
& (Join-Path $PSScriptRoot 'install-camera-driver.ps1') -Scope Machine -Elevate
Write-Host 'Ready. Select Remote Meeting Camera in DingTalk. OBS keeps its separate device.'
