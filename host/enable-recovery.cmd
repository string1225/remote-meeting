@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-health-check.ps1"
if errorlevel 1 pause
