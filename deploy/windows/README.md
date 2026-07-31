# DigiDarts on Windows — mini PC setup

For the DreamQuest Pro (or any Windows 11 mini PC) driving the dartboard.
Goal: plug in power, connect WiFi, and it just works — no manual terminal
steps, no hunting for an IP address.

## 1. Manual OS-level steps (do these yourself, at the machine)

These can't be scripted/SSH'd — they either need a downloaded installer
(Claude doesn't download/run installers on your behalf) or happen during
Windows setup itself:

1. **During Windows 11 setup**, name the PC `digidarts` (Settings → System →
   About → Rename this PC, if you didn't set it during initial setup).
   Reboot for the name change to take effect.
2. **Install Node.js LTS** — [nodejs.org](https://nodejs.org), or via
   `winget install OpenJS.NodeJS.LTS` in an elevated PowerShell/terminal if
   winget is available.
3. **Install Bonjour Print Services for Windows** (Apple's mDNS responder —
   makes `digidarts.local` resolve on your network, same tech as
   AirPlay/AirDrop). Small free download from Apple, ~1MB. This is what
   makes the PC reachable at a consistent name regardless of which WiFi
   network hands it a different IP.
4. **(Optional, for remote setup help)** Enable OpenSSH Server: Settings →
   Apps → Optional Features → Add a feature → OpenSSH Server → install,
   then start the "OpenSSH SSH Server" service.

## 2. Get the code onto the machine

```powershell
git clone https://github.com/tetrahOh/dartboard-system.git
cd dartboard-system\server
npm install
```

(Or `git pull` if it's already cloned and you're picking up updates.)

## 3. Register auto-start (run once, from an elevated PowerShell)

```powershell
cd dartboard-system\deploy\windows
.\register-task.ps1
```

This registers two Scheduled Tasks, both triggered "at log on":
- **DigiDartsServer** — runs `npm start` in `server/`
- **DigiDartsKiosk** — opens Chrome/Edge fullscreen at `http://localhost:8080`,
  ~8 seconds after login (only useful if this PC has its own attached
  display; skip with `.\register-task.ps1 -SkipKiosk` if the actual screen
  is a separate tablet instead)

Test immediately without rebooting: `Start-ScheduledTask -TaskName DigiDartsServer`

## 3b. Register the watchdog (recommended — covers a real failure mode)

Observed live on the DreamQuest Pro: a sleep/wake cycle can kill the
*entire* process tree (including the batch script's own restart loop, not
just the inner `node.exe`), with no clean exit for anything to log or react
to. Neither the self-healing batch loop nor the "at log on" trigger catches
this, since sleep/resume doesn't always fire a fresh logon event. A
separate periodic health check is the real fix:

```powershell
.\register-watchdog.ps1
```

Registers `DigiDartsWatchdog`, which checks `http://localhost:8080` every 5
minutes and restarts the `DigiDartsServer` task if it's not responding.
Logs to `watchdog.log` in this same folder. Verified against a real
worst-case test (killing the entire process tree, not just `node.exe`) — it
correctly detects the outage and recovers within about 10 seconds.

## 4. Verify

- From another device on the same WiFi: `http://digidarts.local:8080`
  should load the setup screen (once Bonjour is installed per step 1.3).
- If mDNS isn't resolving on a given device (Android's Chrome is unreliable
  here), the server also prints its real LAN IP(s) to the console on
  startup as a fallback — check there, or look at `server.js`'s startup log
  directly if you're SSH'd in.
- Reboot cold, confirm the server (and kiosk browser, if registered) comes
  up with zero manual steps.

## 5. Power settings — don't let it sleep

This is a dedicated always-on device, not a laptop, so disable sleep on AC
power (from an elevated prompt):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Without this, Windows' default idle timeout will put the machine to sleep
mid-session — at which point none of the auto-start tasks above matter,
since the whole machine (including its network interface) goes dark.

## 6. Autodarts Desktop (Path A vision pipeline)

If going the Autodarts route (see the main README's Part 2, Path A):

1. Download the Windows installer from
   [autodarts.io/downloads](https://autodarts.io/downloads) and run it.
2. Register its own account at [autodarts.io](https://autodarts.io) and
   create a Dartboard entry there — this is a manual signup step, can't be
   scripted. You'll need the Board ID + API Key it gives you once cameras
   are connected.
3. Register its auto-start task:
   ```powershell
   cd dartboard-system\deploy\windows
   .\register-autodarts-task.ps1
   ```
   This finds the *stable* launcher path (`...\AppData\Local\desktop\Autodarts
   Desktop.exe`) rather than the version-numbered install folder, so it
   keeps working across Autodarts' own auto-updates.
4. Board Manager is reachable at `http://localhost:3180` on the machine
   itself, or `http://<its-ip>:3180` from elsewhere on the network — you'll
   likely need a firewall rule for port 3180 the same way DigiDarts needed
   one for 8080:
   ```powershell
   New-NetFirewallRule -DisplayName "Autodarts Board Manager" -Direction Inbound -LocalPort 3180 -Protocol TCP -Action Allow -Profile Private,Domain
   ```
5. Camera calibration itself needs the actual cameras mounted — nothing to
   do here until that hardware exists.
