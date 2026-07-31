<#
  Registers watchdog.ps1 as a Scheduled Task that runs every 5 minutes
  indefinitely, checking DigiDarts is actually responding and restarting it
  if not. Run once from an elevated PowerShell prompt.
#>

$scriptPath = Join-Path $PSScriptRoot "watchdog.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "DigiDartsWatchdog" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Checks DigiDarts every 5 min, restarts it if unresponsive" -Force

Write-Host "Registered 'DigiDartsWatchdog' - checks every 5 minutes, restarts DigiDartsServer if down."
Write-Host "Test now with: Start-ScheduledTask -TaskName DigiDartsWatchdog"
