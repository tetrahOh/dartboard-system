"""
calibrate.py -- FULL DIY PATH (build your own detector instead of using Autodarts)

For each camera, click 4+ known reference points on the board (segment wire
intersections are ideal, e.g. where the 20/1 double-ring line crosses the
20/5/1/... spokes) and enter their real-world mm coordinates (measured from
board center, standard dartboard geometry). This produces a homography matrix
that maps ANY pixel in that camera's frame to a real (x_mm, y_mm) position on
the board plane -- which is what lets you compute the score.

Reference geometry you can use for clicking (mm from board center, standard
board): the 20 segment centerline points straight up. Segment boundaries are
every 18 degrees. Good click targets: the outer double-ring edge (r=170mm)
at each spoke boundary, since those points are visually crisp (wire meets
wire) -- click at least 4, ideally 6-8, spread around the board for accuracy.

Usage:
    python calibrate.py --camera 0 --out cam0_homography.npy

Controls:
    Left click  = record a reference point (you'll be prompted in the
                  terminal for its true x_mm,y_mm)
    'u'         = undo last point
    's'         = solve homography and save once you have >= 4 points
    'q'         = quit without saving
"""

import argparse
import cv2
import numpy as np

points_px = []
points_mm = []


def mouse_cb(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN:
        points_px.append((x, y))
        print(f"\nClicked pixel ({x},{y}).")
        try:
            xm = float(input("  true x_mm from board center (right = +): "))
            ym = float(input("  true y_mm from board center (up = +):    "))
        except ValueError:
            print("  invalid number, discarding point")
            points_px.pop()
            return
        points_mm.append((xm, ym))
        print(f"  recorded point #{len(points_px)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--out", required=True, help="output .npy file for the homography matrix")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {args.camera}")

    win = f"Calibrate camera {args.camera}"
    cv2.namedWindow(win)
    cv2.setMouseCallback(win, mouse_cb)

    print("Click reference points on the board (see docstring for guidance).")
    print("Press 's' to solve + save once you have at least 4 points, 'u' to undo, 'q' to quit.")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        for (x, y) in points_px:
            cv2.circle(frame, (x, y), 5, (0, 255, 0), -1)
        cv2.putText(frame, f"points: {len(points_px)}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow(win, frame)
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        if key == ord('u') and points_px:
            points_px.pop()
            points_mm.pop()
        if key == ord('s'):
            if len(points_px) < 4:
                print("Need at least 4 points.")
                continue
            src = np.array(points_px, dtype=np.float32)
            dst = np.array(points_mm, dtype=np.float32)
            H, mask = cv2.findHomography(src, dst, cv2.RANSAC)
            if H is None:
                print("Homography solve failed -- check your points and try again.")
                continue
            np.save(args.out, H)
            print(f"Saved homography to {args.out}")
            print(H)
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
