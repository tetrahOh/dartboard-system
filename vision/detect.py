"""
detect.py -- FULL DIY PATH (build your own detector instead of using Autodarts)

This is the from-scratch computer-vision loop referenced in the README. It
follows the same approach as the well-known open-source project
opencv-steel-darts (github.com/hanneshoettinger/opencv-steel-darts):

  1. Each camera has a fixed homography (from calibrate.py) mapping its
     pixels to real mm coordinates on the board plane.
  2. On startup, capture a clean "empty board" reference frame per camera.
  3. Each loop: diff the live frame against the reference frame. A dart
     landing creates a new blob that appears and then stays still.
  4. Once a blob is stable for a few frames, take its entry point (topmost
     point of the blob, closest to the board surface) as the dart position
     in that camera's pixels, and map it to mm via the homography.
  5. Average the mm position across all connected cameras (this is what
     cancels out most of the parallax error from any single camera).
  6. Convert mm -> (segment, multiplier) using standard board geometry, and
     POST the result to the scoring server.
  7. When all blobs disappear (player pulled the darts), reset the
     reference frame and wait for the next leg.

Accuracy note: this simple version is a solid weekend-project starting
point, but real accuracy takes real tuning -- consistent 360-degree
lighting to kill shadows (see README hardware section), 3 cameras (not 2)
for redundancy, and filtering out the sector wires from your diff mask.
For a system as accurate as commercial ones out of the box, use
autodarts_bridge.py against the free Autodarts engine instead -- it already
solves these problems with a YOLO-based model. Use this script if you want
to build the vision pipeline yourself as a learning project.

Install:
    pip install opencv-python numpy requests

Run (2 or 3 cameras):
    python detect.py --cameras 0 1 2 --homographies cam0_homography.npy cam1_homography.npy cam2_homography.npy \
        --server http://localhost:8080 --game-id 1
"""

import argparse
import time

import cv2
import numpy as np
import requests

ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]

# standard board radii, mm
R_BULLSEYE = 6.35
R_OUTER_BULL = 15.9
R_TRIPLE_IN = 99
R_TRIPLE_OUT = 107
R_DOUBLE_IN = 162
R_DOUBLE_OUT = 170

STABLE_FRAMES = 5          # consecutive still frames before we call it "landed"
MOTION_THRESHOLD = 25      # pixel intensity diff threshold
MIN_BLOB_AREA = 40         # ignore tiny noise blobs


def mm_to_score(x_mm, y_mm):
    r = (x_mm ** 2 + y_mm ** 2) ** 0.5
    if r > R_DOUBLE_OUT:
        return "MISS", 1
    if r <= R_BULLSEYE:
        return "BULL", 2
    if r <= R_OUTER_BULL:
        return "BULL", 1

    angle = (np.degrees(np.arctan2(x_mm, y_mm))) % 360  # 0 = straight up, clockwise
    idx = int(((angle + 9) % 360) // 18)
    number = ORDER[idx]

    if R_TRIPLE_IN < r <= R_TRIPLE_OUT:
        return number, 3
    if R_DOUBLE_IN < r <= R_DOUBLE_OUT:
        return number, 2
    return number, 1


class CameraTracker:
    def __init__(self, index, homography_path):
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            raise SystemExit(f"Could not open camera {index}")
        self.H = np.load(homography_path)
        self.reference = None
        self.stable_count = 0
        self._prime_reference()

    def _prime_reference(self):
        # average a few frames of the empty board for a clean baseline
        frames = []
        for _ in range(10):
            ok, f = self.cap.read()
            if ok:
                frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
            time.sleep(0.03)
        if frames:
            self.reference = np.mean(frames, axis=0).astype(np.uint8)

    def reset_reference(self):
        self._prime_reference()
        self.stable_count = 0

    def read_blob_pixel(self):
        """Returns the tip pixel (x,y) of a newly-landed, stable dart, or None."""
        ok, frame = self.cap.read()
        if not ok or self.reference is None:
            return None
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, self.reference)
        _, mask = cv2.threshold(diff, MOTION_THRESHOLD, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = [c for c in contours if cv2.contourArea(c) > MIN_BLOB_AREA]
        if not contours:
            self.stable_count = 0
            return None

        largest = max(contours, key=cv2.contourArea)
        # tip = topmost point of the blob (closest to the board surface for a
        # camera looking across the board at a shallow angle)
        tip = tuple(largest[largest[:, :, 1].argmin()][0])

        self.stable_count += 1
        if self.stable_count >= STABLE_FRAMES:
            return tip
        return None

    def pixel_to_mm(self, px):
        pt = np.array([[px]], dtype=np.float32)
        mm = cv2.perspectiveTransform(pt, self.H)
        return float(mm[0][0][0]), float(mm[0][0][1])

    def board_is_clear(self):
        ok, frame = self.cap.read()
        if not ok or self.reference is None:
            return True
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, self.reference)
        return diff.mean() < 3  # near-zero difference = darts removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", nargs="+", type=int, required=True)
    ap.add_argument("--homographies", nargs="+", required=True)
    ap.add_argument("--server", default="http://localhost:8080")
    ap.add_argument("--game-id", required=True)
    args = ap.parse_args()

    if len(args.cameras) != len(args.homographies):
        raise SystemExit("Need one homography file per camera")

    trackers = [CameraTracker(c, h) for c, h in zip(args.cameras, args.homographies)]
    print(f"Tracking with {len(trackers)} camera(s). Waiting for throws...")

    darts_this_turn = 0
    already_scored_this_stability = [False] * len(trackers)

    while True:
        mm_points = []
        for i, t in enumerate(trackers):
            px = t.read_blob_pixel()
            if px and not already_scored_this_stability[i]:
                mm_points.append(t.pixel_to_mm(px))
                already_scored_this_stability[i] = True

        if mm_points:
            x_mm = float(np.mean([p[0] for p in mm_points]))
            y_mm = float(np.mean([p[1] for p in mm_points]))
            segment, multiplier = mm_to_score(x_mm, y_mm)

            resp = requests.post(
                f"{args.server}/api/game/{args.game_id}/throw",
                json={"segment": segment, "multiplier": multiplier},
                timeout=3,
            )
            darts_this_turn += 1
            print(f"Dart #{darts_this_turn}: ({x_mm:.0f},{y_mm:.0f})mm -> "
                  f"{multiplier}x{segment} (server {resp.status_code})")

        # once all trackers see a clear board again, reset for the next leg/turn
        if darts_this_turn >= 3 and all(t.board_is_clear() for t in trackers):
            print("Board clear -- resetting for next turn.")
            for t in trackers:
                t.reset_reference()
            already_scored_this_stability = [False] * len(trackers)
            darts_this_turn = 0

        time.sleep(0.03)


if __name__ == "__main__":
    main()
