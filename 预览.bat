@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [atlas] Node.js not found in PATH. Please install Node 18+ first.
  pause
  exit /b 1
)

if not exist "atlas-extension\dist\atlas-ui-core.mjs" (
  echo [atlas] dist bundle missing, building now...
  node "tools\build.mjs"
)

node "dev-preview\serve.mjs"
if errorlevel 1 pause
