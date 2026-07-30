"""
autodarts_bridge.py

RECOMMENDED PATH: use the free, open-source Autodarts detection engine
(https://autodarts.io) for the actual camera/computer-vision work -- it's a
mature, community-tuned 3-camera triangulation system -- and pipe its throw
events into YOUR custom web app (this project) for the game display.

How it works:
  1. You set up Autodarts normally (3 webcams + LED ring + mini PC), per
     https://autodarts.diy  -- this handles calibration and dart detection.
  2. Its local "Board Manager" exposes a WebSocket on your board machine at
     ws://<board-ip>:3180/api/events (also viewable at http://<board-ip>:3180).
  3. This script listens to that WebSocket, translates each detected throw
     into {segment, multiplier}, and POSTs it to our own server's
     /api/game/:id/throw endpoint -- so our custom web app lights up in
     real time, using Autodarts purely as the "eyes".

You will need to adjust `parse_autodarts_event` below once you inspect the
exact JSON your Board Manager version emits (Autodarts is under active
development and the schema has changed between versions) -- connect once,
print raw messages, and match fields to segment/multiplier.

Install:
    pip install websockets requests

Run:
    python autodarts_bridge.py --board-ip 192.168.1.50 --game-id 1 --server http://localhost:8080
"""

import argparse
import asyncio
import json
import re

import requests
import websockets

SEGMENT_RE = re.compile(r"^(S|D|T)?(\d{1,2}|B|BULL)$")


def parse_autodarts_field(field: str):
    """Translate an Autodarts-style throw code (e.g. 'T20', 'D5', 'S1', 'B', 'DB')
    into (segment, multiplier) for our game engine."""
    field = field.strip().upper()
    if field in ("B", "25", "SB"):
        return "BULL", 1
    if field in ("DB", "BULL50", "50"):
        return "BULL", 2
    m = SEGMENT_RE.match(field)
    if not m:
        return "MISS", 1
    prefix, num = m.groups()
    multiplier = {"S": 1, "D": 2, "T": 3}.get(prefix, 1)
    return int(num), multiplier


async def bridge(board_ip: str, game_id: str, server: str):
    uri = f"ws://{board_ip}:3180/api/events"
    print(f"Connecting to Autodarts Board Manager at {uri} ...")
    async with websockets.connect(uri) as ws:
        print("Connected. Waiting for throws -- throw a dart to test.")
        async for raw in ws:
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            print("RAW EVENT:", event)  # inspect this to adapt the parser below

            # --- adapt this block to match your Board Manager's real schema ---
            throw_field = None
            if event.get("event") == "throw" and "points" in event:
                throw_field = event["points"].get("name")  # e.g. "T20"
            # --------------------------------------------------------------

            if not throw_field:
                continue

            segment, multiplier = parse_autodarts_field(throw_field)
            resp = requests.post(
                f"{server}/api/game/{game_id}/throw",
                json={"segment": segment, "multiplier": multiplier},
                timeout=3,
            )
            print(f"Forwarded {throw_field} -> segment={segment} multiplier={multiplier} "
                  f"(server responded {resp.status_code})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--board-ip", required=True, help="IP of the machine running Autodarts Board Manager")
    ap.add_argument("--game-id", required=True, help="Game id created via POST /api/game on our server")
    ap.add_argument("--server", default="http://localhost:8080", help="Base URL of our dart-scoring server")
    args = ap.parse_args()
    asyncio.run(bridge(args.board_ip, args.game_id, args.server))
