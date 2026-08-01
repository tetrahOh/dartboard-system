<#
  Periodic health check for DigiDarts and Autodarts Board Manager. Restarts
  the relevant scheduled task if either stops responding, for any reason -
  not just a clean process exit (which start-digidarts.bat's own restart
  loop already handles for DigiDarts), but also the sleep/wake-related
  process kills observed live on the DreamQuest Pro, where the whole
  process tree vanished without anything getting a chance to log it.
  Autodarts Desktop has no self-healing loop of its own, so it relies on
  this watchdog entirely.

  Registered as its own recurring Scheduled Task (see register-watchdog.ps1)
  rather than relying solely on the AtLogOn trigger + self-healing batch
  loop, since a sleep/wake cycle doesn't always fire a fresh logon event to
  re-trigger AtLogOn in the first place.
#>

$logPath = "$PSScriptRoot\watchdog.log"

function Test-ServiceHealthy {
  param([string]$Url, [string]$TaskName, [string]$Label)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -ne 200) { throw "unexpected status $($response.StatusCode)" }
  } catch {
    Add-Content -Path $logPath -Value "[$(Get-Date)] $Label not responding ($_) - restarting task"
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    } catch {
      Add-Content -Path $logPath -Value "[$(Get-Date)] ${Label}: Stop-ScheduledTask failed: $_"
    }
    Start-Sleep -Seconds 1
    try {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    } catch {
      Add-Content -Path $logPath -Value "[$(Get-Date)] ${Label}: Start-ScheduledTask failed: $_"
    }
  }
}

Test-ServiceHealthy -Url "http://localhost:8080" -TaskName "DigiDartsServer" -Label "DigiDarts"
Test-ServiceHealthy -Url "http://localhost:3180" -TaskName "AutodartsDesktop" -Label "Autodarts Board Manager"

# Claude Desktop is a Windows Store (MSIX) app, not an HTTP service - it has
# no port to poll, so this checks the process directly instead. Keeping it
# running is what lets phone/remote sessions connect instead of showing
# "disconnected" - relaunched via its AppsFolder identity since Store apps
# can't be started from a raw .exe path.
function Test-ClaudeDesktopRunning {
  if (Get-Process -Name "Claude" -ErrorAction SilentlyContinue) { return }
  Add-Content -Path $logPath -Value "[$(Get-Date)] Claude Desktop not running - relaunching"
  try {
    Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude" -ErrorAction Stop
  } catch {
    Add-Content -Path $logPath -Value "[$(Get-Date)] Claude Desktop: relaunch failed: $_"
  }
}
Test-ClaudeDesktopRunning
