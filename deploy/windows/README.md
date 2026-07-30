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

## 4. Verify

- From another device on the same WiFi: `http://digidarts.local:8080`
  should load the setup screen (once Bonjour is installed per step 1.3).
- If mDNS isn't resolving on a given device (Android's Chrome is unreliable
  here), the server also prints its real LAN IP(s) to the console on
  startup as a fallback — check there, or look at `server.js`'s startup log
  directly if you're SSH'd in.
- Reboot cold, confirm the server (and kiosk browser, if registered) comes
  up with zero manual steps.
