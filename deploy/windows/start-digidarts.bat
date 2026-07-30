@echo off
REM Launches the DigiDarts server. Called by the Task Scheduler entry
REM registered via register-task.ps1 - not meant to be run manually,
REM though double-clicking it works fine too for a quick manual test.

cd /d "%~dp0..\..\server"
npm start
