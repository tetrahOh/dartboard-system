<#
  Periodic health check for the DigiDarts server. Restarts the
  DigiDartsServer scheduled task if the app stops responding, for any
  reason - not just a clean process exit (which start-digidarts.bat's own
  restart loop already handles), but also the sleep/wake-related process
  kills observed live on the DreamQuest Pro, where the whole process tree
  vanished without the batch loop getting a chance to log anything.

  Registered as its own recurring Scheduled Task (see register-watchdog.ps1)
  rather than relying solely on the AtLogOn trigger + self-healing batch
  loop, since a sleep/wake cycle doesn't always fire a fresh logon event to
  re-trigger AtLogOn in the first place.
#>

$logPath = "$PSScriptRoot\watchdog.log"

try {
  $response = Invoke-WebRequest -Uri "http://localhost:8080" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  if ($response.StatusCode -ne 200) { throw "unexpected status $($response.StatusCode)" }
} catch {
  Add-Content -Path $logPath -Value "[$(Get-Date)] DigiDarts not responding ($_) - restarting task"
  Stop-ScheduledTask -TaskName DigiDartsServer -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName DigiDartsServer
}
