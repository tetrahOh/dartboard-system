# DIY Camera Dart System — Build Guide

A camera-tracked steel dartboard with a custom web app (like 501fun) that you
run on a tablet, phone, or iPad. Darts are scored automatically by camera;
the web app handles the games, scoreboard, checkouts, and turn logic.

## How the pieces fit together

```
 [ 3 cameras + LED ring around a real steel dartboard ]
                    |
        (detects each dart's landing spot)
                    v
        [ vision layer: segment + multiplier ]
                    |
      HTTP POST /api/game/:id/throw
                    v
     [ Node.js server: server/  — game rules engine ]
                    |
      WebSocket broadcast (live state)
                    v
   [ Web app: public/  — scoreboard on tablet/phone/iPad ]
```

The web app and vision layer are decoupled on purpose. The exact same
`/api/game/:id/throw` endpoint that a camera script calls is also what the
on-screen clickable dartboard calls — so **the whole game app works today**,
before you've built any hardware, using manual taps. You add the camera
later and nothing about the app changes.

## Part 1 — Hardware

| Item | Notes |
|---|---|
| Standard bristle steel-tip dartboard | Not an electronic dartboard — you need a normal one for cameras to watch. |
| 3x USB webcams (e.g. Logitech C270/C920 or similar) | 3 cameras, not 1–2, is what makes accurate automatic scoring possible — a single camera can't tell how far a dart's tip is from its shaft along the camera's sightline, so its score reading drifts with parallax. Three cameras looking from different angles let you cross-check the landing point. |
| 360° LED ring light | Critical, not optional. Shadows cast by the dart shaft are the #1 cause of false detections. Mount it flush around the board edge, in front of the camera plane. |
| Camera mounting arms / bracket or enclosure | 3D-printed arms that clip to the LED ring are the common approach (see the Autodarts camera positioning guide linked below); a wooden surround/cabinet works too if you don't have a printer. |
| Mini PC to run the vision software | Raspberry Pi 5, an Intel NUC, or an old laptop. Anything Linux-capable with 3 free USB ports. |
| Tablet / phone / iPad | This just opens a web page — the game display. No app install needed. |

**Camera placement:** mount all 3 cameras at roughly the same height as the
board's outer edge, angled slightly downward across the board face (not
straight-on), spaced roughly 120° apart. The goal is for each camera to see
the whole board face at a shallow, raking angle, so a dart's tip and its
entry point into the board are close together in that camera's image.

## Part 2 — Choose your vision path

You have two real options for the "eyes" of the system. Both feed the same
web app.

### Path A — Use Autodarts (recommended, get playing this week)

[Autodarts](https://autodarts.io) is a free, open-source, actively
maintained 3-camera dart-tracking engine — the same category of system as
501fun, but you can self-host it. Rather than reinventing multi-camera
triangulation and dart-tip detection from scratch, use it for detection and
point it at our custom web app for the game experience.

1. Follow the official DIY hardware + software setup: https://autodarts.diy
   (camera positioning guide, software install for Pi/NUC/Jetson).
2. Once it's running, open `http://<board-ip>:3180` and confirm it detects
   throws correctly in its own interface first.
3. Run our bridge script, which listens to Autodarts' local events and
   forwards each throw into our web app:
   ```bash
   cd vision
   pip install websockets requests
   python autodarts_bridge.py --board-ip <board-ip> --game-id <id> --server http://localhost:8080
   ```
4. **Important:** Autodarts' event schema can differ by version. The first
   time you run the bridge, it prints every raw event it receives — throw a
   dart, look at the printed JSON, and adjust the `parse_autodarts_event`
   block in `vision/autodarts_bridge.py` to match the field names you see.

### Path B — Build your own detector from scratch (full DIY, more work)

If you want to build the computer-vision pipeline yourself as a project
(rather than reuse Autodarts), `vision/calibrate.py` and `vision/detect.py`
in this project are a working starting point, based on the same technique
as the well-documented open-source reference project
[opencv-steel-darts](https://github.com/hanneshoettinger/opencv-steel-darts):

1. **Calibrate each camera.** For each of your 2–3 cameras, run:
   ```bash
   pip install opencv-python numpy requests
   python vision/calibrate.py --camera 0 --out cam0_homography.npy
   ```
   Click 6–8 reference points on the board where wires cross (crisp, easy to
   click precisely), typing in each point's true mm-from-center coordinates
   when prompted. This builds a **homography matrix** — a transform from
   "pixel in this camera" to "real position on the board" — which is the
   core trick that makes single-plane camera scoring geometrically correct.
   Repeat for every camera.

2. **Run detection:**
   ```bash
   python vision/detect.py --cameras 0 1 2 \
     --homographies cam0_homography.npy cam1_homography.npy cam2_homography.npy \
     --server http://localhost:8080 --game-id <id>
   ```
   This watches all cameras, detects new dart blobs via frame differencing,
   converts each camera's pixel hit to mm using its homography, **averages
   across cameras** (this is what cancels out most parallax error), converts
   the averaged position to a segment/multiplier using standard board
   geometry, and posts it to the web app.

3. **Tune it.** Realistically, this step is most of the work: adjust
   `MOTION_THRESHOLD` and `MIN_BLOB_AREA` in `detect.py` for your lighting,
   make sure your LED ring kills shadows, and consider masking out the
   sector wires from your diff mask if you get false triggers on wire glare.

Path B is a genuinely good weekend/ongoing electronics-and-CV project — just
know going in that matching Autodarts' out-of-the-box accuracy takes real
tuning time.

## Part 3 — Run the web app

This works today, with or without cameras (use the on-screen board to test).

```bash
cd server
npm install
npm start
```

Then, from your tablet/phone/iPad (on the same WiFi network as the
computer running the server), open:

```
http://<computer's-local-ip>:8080
```

You'll land on the **DigiDarts** setup screen: pick a game mode, add 1-10
players (optionally split into teams), then start. The clickable dartboard
mirrors real board geometry (singles, doubles, triples, bullseye), and every
score updates all connected devices live over WebSocket — so a tablet on the
wall can display the scoreboard while a phone (or the camera bridge script)
reports the throws.

### Game modes

| Mode | Rules |
|---|---|
| 501 / 301 / 701 | Classic countdown, double-out or straight-out, best-of-N legs. |
| Cricket | Close 15-20 and Bull before your rivals; score on numbers still open. |
| Around the Clock | Hit 1 through 20, then Bull, in order. First there wins. |
| Killer | Double your own (randomly assigned) number to go "killer," then hit opponents' numbers to take their lives. Last one standing wins. |
| Shanghai | 20 rounds, one target number each (round *n* targets the number *n*). Hitting single+double+triple of the round's number in one turn is an instant win; otherwise highest total after 20 rounds wins. |
| Halve It | Each round has a required target; miss it entirely on your turn and your running score is cut in half. |
| Limit | A rotating "setter" throws first each round and sets the limit (which can only ratchet **down**); everyone else must meet or beat it or lose a life. 3 lives by default, last one standing wins. |

**Teams**: any mode can be played as Team A vs Team B (vs C, D...) — turn
order alternates between teams' members, but score/lives/marks are shared
per team. Assign players to teams with the chips on the setup screen, or hit
**Shuffle players** to redistribute randomly.

### Hosting it publicly (optional)

`render.yaml` in the repo root is a [Render](https://render.com) Blueprint —
Render's free web-service tier runs Node + WebSocket apps with no credit
card required. To deploy: sign in to Render with GitHub, click **New +** →
**Blueprint**, pick this repo, and accept the defaults. Two things to know
about the free tier before you rely on it for game night:

- The service **sleeps after ~15 minutes idle** and takes ~30-60s to wake on
  the next request — fine for casual use, annoying mid-leg.
- Game state is **in-memory only**, so a sleep/restart wipes any game in
  progress. Game IDs are random (not sequential) specifically so a public
  URL can't be walked by guessing `/api/game/1`, `/api/game/2`, etc. — but
  there's still no login, so anyone with a game's URL can throw/undo on it.

### The API your camera script talks to

```
POST /api/game                     create a game
                                    { "type": "x01"|"cricket"|"around_the_clock"|"killer"|"shanghai"|"halve_it"|"limit",
                                      "startScore", "doubleOut", "legsToWin", "livesStart",
                                      "players": [{"id","name","teamId"?}],
                                      "teams"?: [{"id","name"}] }
GET  /api/game/:id                 current state
POST /api/game/:id/throw           { "segment": 20 | "BULL" | "MISS", "multiplier": 1|2|3 }
POST /api/game/:id/undo            undo last dart / turn
```

This is the only integration point that matters — anything that can POST
JSON (Autodarts bridge, your own OpenCV script, or even a phone app) can
drive the scoreboard, regardless of which game mode is active.

## What's included in this project

```
dartboard-system/
├── server/
│   ├── gameEngine.js     501/301/701 + Cricket rules, bust/checkout logic, undo
│   ├── server.js         Express + WebSocket server, the API above
│   └── package.json
├── public/
│   ├── index.html        setup screen + game screen
│   ├── board.js          generates the accurate clickable SVG dartboard
│   ├── app.js            frontend logic, REST + WebSocket wiring
│   └── style.css
├── vision/
│   ├── autodarts_bridge.py   Path A: forwards Autodarts events to our app
│   ├── calibrate.py          Path B: per-camera homography calibration
│   └── detect.py             Path B: multi-camera dart detection loop
└── README.md              (this file)
```

## Extending the game engine

`server/gameEngine.js` is where to add more game modes (Around the Clock,
Shanghai, Killer, etc.) — it's isolated from the web/networking code, and
`getState()` is the single source of truth the frontend renders from. The
frontend never computes scores itself; it only ever displays whatever the
engine returns and sends raw `{segment, multiplier}` throws, so the same
engine works identically whether a throw came from a fingertip tap or a
camera three meters away.
