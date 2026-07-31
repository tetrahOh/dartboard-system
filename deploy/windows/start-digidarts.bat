@echo off
REM Launches the DigiDarts server, auto-restarting if it ever exits (e.g.
REM the Node process dying across a sleep/wake cycle - observed live during
REM setup) and logging each start/stop to digidarts.log for diagnosis.
REM Called by the Task Scheduler entry registered via register-task.ps1.

cd /d "%~dp0..\..\server"

:loop
echo [%date% %time%] Starting DigiDarts server >> "%~dp0digidarts.log"
call npm start >> "%~dp0digidarts.log" 2>&1
echo [%date% %time%] Server exited (restarting in 5s) >> "%~dp0digidarts.log"
timeout /t 5 /nobreak > nul
goto loop
