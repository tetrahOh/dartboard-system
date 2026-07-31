<#
  Registers an "At log on" Scheduled Task so Autodarts Desktop (Board
  Manager) starts automatically, same pattern as register-task.ps1 for the
  DigiDarts server itself.

  Uses the STABLE launcher path (the Squirrel stub at
  ...\AppData\Local\desktop\Autodarts Desktop.exe), not the versioned
  ...\app-X.Y.Z\ path - the versioned folder gets replaced whenever
  Autodarts auto-updates itself, which would silently break a task pointed
  directly at it.

  Run from an elevated PowerShell prompt on the machine itself (adjust
  $exePath if the Windows username differs from what's hardcoded below).
#>

param(
  [string]$ExePath = "$env:LOCALAPPDATA\..\Local\desktop\Autodarts Desktop.exe"
)

$resolvedPath = Resolve-Path $ExePath -ErrorAction SilentlyContinue
if (-not $resolvedPath) {
  Write-Error "Can't find Autodarts Desktop at $ExePath - pass -ExePath explicitly if it's installed elsewhere."
  exit 1
}

$action = New-ScheduledTaskAction -Execute $resolvedPath.Path
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "AutodartsDesktop" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Starts Autodarts Desktop / Board Manager on login" -Force

Write-Host "Registered 'AutodartsDesktop' - starts $($resolvedPath.Path) on next login."
Write-Host "Test now with: Start-ScheduledTask -TaskName AutodartsDesktop"
