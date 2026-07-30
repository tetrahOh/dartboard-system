<#
  Registers two "At log on" Scheduled Tasks so DigiDarts starts itself with
  zero manual steps:
    1. DigiDartsServer  - runs start-digidarts.bat (npm start)
    2. DigiDartsKiosk   - launches the default browser in kiosk mode,
                          pointed at the local server (only useful if this
                          PC also drives its own attached display - skip
                          registering this one if the "screen" is actually
                          a separate tablet)

  Run this from an elevated PowerShell prompt, from inside this same
  deploy/windows folder (or pass -RepoRoot explicitly).

  Usage:
    .\register-task.ps1                          # both tasks
    .\register-task.ps1 -SkipKiosk                # server only, no local display
#>

param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\.."),
  [switch]$SkipKiosk
)

$batPath = Join-Path $RepoRoot "deploy\windows\start-digidarts.bat"
if (-not (Test-Path $batPath)) {
  Write-Error "Can't find $batPath - run this script from inside the dartboard-system repo."
  exit 1
}

# --- Server auto-start ---
$serverAction = New-ScheduledTaskAction -Execute $batPath -WorkingDirectory (Split-Path $batPath)
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn
$serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName "DigiDartsServer" -Action $serverAction -Trigger $serverTrigger `
  -Settings $serverSettings -Description "Starts the DigiDarts game server on login" -Force

Write-Host "Registered 'DigiDartsServer' - starts npm start on next login."

# --- Kiosk browser auto-start (optional) ---
if (-not $SkipKiosk) {
  $chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  $browser = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $browser) {
    Write-Warning "No Chrome/Edge install found - skipping kiosk task. Install one, then re-run without -SkipKiosk, or launch manually with: <browser.exe> --kiosk http://localhost:8080"
  } else {
    # Delay a few seconds so the server task above has time to start listening first.
    $kioskAction = New-ScheduledTaskAction -Execute "cmd.exe" `
      -Argument "/c timeout /t 8 && `"$browser`" --kiosk http://localhost:8080 --noerrdialogs --disable-session-crashed-bubble"
    $kioskTrigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "DigiDartsKiosk" -Action $kioskAction -Trigger $kioskTrigger `
      -Settings $serverSettings -Description "Opens DigiDarts fullscreen on login (only if this PC has its own display)" -Force
    Write-Host "Registered 'DigiDartsKiosk' - opens $browser in kiosk mode ~8s after login."
  }
}

Write-Host ""
Write-Host "Done. Test now with: Start-ScheduledTask -TaskName DigiDartsServer"
Write-Host "Or just log off and back on to see it happen automatically."
