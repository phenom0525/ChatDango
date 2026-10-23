@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || ( echo Node.js not found. Install it from https://nodejs.org and run start.bat again. & pause & exit /b 1 )
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 5178 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' }"
timeout /t 2 /nobreak >nul
rem Open as an app-style window with the first Chromium browser found (Brave, Edge, Chrome); otherwise the default browser.
set "URL=http://127.0.0.1:5178"
for %%B in (
  "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
  "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do if exist %%B ( start "" %%B --app=%URL% & exit /b 0 )
start "" %URL%
