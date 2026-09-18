#!/usr/bin/env python3
"""Entrance recognition service. Runs continuously on the mini PC.

    python3 service.py                 # live camera
    python3 service.py --source clip.mp4 --no-post --window   # dry run

Pipeline, per pass rather than per frame:

    grab frame -> downscale -> MOTION GATE -> detect faces -> IoU-track
      -> on track end: pick sharpest crop, embed once, 1:N match
      -> infer direction from how the face box grew
      -> cooldown check -> POST to the backend (queued if it's down)

Two things make this fit on a fanless N100:

  * The motion gate. Detection costs ~100ms a frame; a frame difference on an
    80x60 thumbnail costs microseconds. A doorway is empty most of the day, so
    most frames never reach the detector at all. This is the big one.
  * Embedding once per track rather than once per frame for the register.

The live view the warden watches is sent only while someone is actually
looking at it — see PreviewSender. Nobody watching costs nothing.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from core import (
    Cooldown,
    MotionGate,
    Observation,
    Tracker,
    build_overlay,
    check_liveness,
    identify,
    l2_normalize,
    load_gallery,
    sharpness,
    track_direction,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
QUEUE_FILE = DATA / "pending_events.json"
EMBEDDINGS_FILE = DATA / "embeddings.json"

log = logging.getLogger("recognition")


def http_json(url: str, token: str, payload: dict | None = None, timeout: float = 4.0):
    """One request, returning parsed JSON or None. Never raises."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Service-Token"] = token
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data else "GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        return None


class Config:
    """Everything tunable, from the environment. See .env.example."""

    def __init__(self, args):
        self.source = args.source if args.source is not None else os.getenv("CAMERA_SOURCE", "0")
        self.api = os.getenv("API_URL", "http://localhost:4000").rstrip("/")
        self.api_token = os.getenv("SERVICE_TOKEN", "")
        self.detect_width = int(os.getenv("DETECT_WIDTH", "640"))
        self.det_size = int(os.getenv("DET_SIZE", "640"))
        self.model = os.getenv("MODEL_PACK", "buffalo_l")
        self.threshold = float(os.getenv("MATCH_THRESHOLD", "0.42"))
        self.margin = float(os.getenv("MATCH_MARGIN", "0.06"))
        self.cooldown = float(os.getenv("COOLDOWN_SECONDS", "120"))
        self.min_face_px = int(os.getenv("MIN_FACE_PX", "60"))
        self.min_track_len = int(os.getenv("MIN_TRACK_FRAMES", "3"))
        # Which way the camera faces. "in" = a face growing larger is someone
        # walking in through the door. Flip if the camera watches people leave.
        self.approach_means = os.getenv("APPROACH_MEANS", "in")
        self.log_unknowns = os.getenv("LOG_UNKNOWNS", "1") == "1"

        # --- pacing -------------------------------------------------------
        # The camera may offer 30fps; a walk-past lasts a second or more, so
        # 12 is plenty and the spare cycles stay free for everything else.
        self.max_fps = float(os.getenv("MAX_FPS", "12"))

        # --- motion gate --------------------------------------------------
        self.motion_enabled = os.getenv("MOTION_GATE", "1") == "1"
        self.motion_width = int(os.getenv("MOTION_WIDTH", "80"))
        self.motion_pixel_delta = float(os.getenv("MOTION_PIXEL_DELTA", "8"))
        self.motion_min_changed = float(os.getenv("MOTION_MIN_CHANGED", "0.0035"))
        self.motion_hold_frames = int(os.getenv("MOTION_HOLD_FRAMES", "18"))
        self.motion_force_every = int(os.getenv("MOTION_FORCE_EVERY", "24"))

        # --- live view ----------------------------------------------------
        self.preview_enabled = os.getenv("LIVE_VIEW", "1") == "1"
        self.preview_fps = float(os.getenv("LIVE_VIEW_FPS", "4"))
        self.preview_width = int(os.getenv("LIVE_VIEW_WIDTH", "480"))
        self.preview_quality = int(os.getenv("LIVE_VIEW_QUALITY", "60"))

        # --- enrollment pickup --------------------------------------------
        # Re-read embeddings.json when it changes, so adding a guest in the
        # browser takes effect without anyone opening a terminal.
        self.gallery_poll = float(os.getenv("GALLERY_POLL_SECONDS", "5"))

        # Off by default — see check_liveness's docstring and the README for
        # why. Turning it on costs a color crop per observation.
        self.liveness_enabled = os.getenv("LIVENESS_ENABLED", "0") == "1"
        self.liveness_blur_floor = float(os.getenv("LIVENESS_BLUR_FLOOR", "60"))
        self.liveness_chroma_low = float(os.getenv("LIVENESS_CHROMA_LOW", "5"))
        self.liveness_chroma_high = float(os.getenv("LIVENESS_CHROMA_HIGH", "32"))
        self.liveness_glare_ceiling = float(os.getenv("LIVENESS_GLARE_CEILING", "0.12"))

        self.post = not args.no_post
        self.window = args.window  # local OpenCV window, for bench testing


class EventSender:
    """POSTs events, and survives the backend being down.

    Every event carries a client-generated event_id; the backend treats a
    repeat as a no-op, so retrying a queued event can't double-toggle a
    guest's in/out state.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.queue: deque[dict] = deque(maxlen=5000)
        self._load_queue()

    def _load_queue(self) -> None:
        if QUEUE_FILE.exists():
            try:
                self.queue.extend(json.loads(QUEUE_FILE.read_text(encoding="utf-8")))
                log.info("recovered %d queued events from disk", len(self.queue))
            except (json.JSONDecodeError, OSError) as e:
                log.warning("could not read event queue: %s", e)

    def _save_queue(self) -> None:
        DATA.mkdir(parents=True, exist_ok=True)
        try:
            tmp = QUEUE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(list(self.queue)), encoding="utf-8")
            tmp.replace(QUEUE_FILE)
        except OSError as e:
            log.warning("could not persist event queue: %s", e)

    def _post(self, path: str, payload: dict) -> bool:
        req = urllib.request.Request(
            f"{self.cfg.api}{path}",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                **({"X-Service-Token": self.cfg.api_token} if self.cfg.api_token else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return 200 <= r.status < 300
        except urllib.error.HTTPError as e:
            # 4xx is our bug, not a network blip — don't retry it forever.
            log.error("backend rejected event: %s %s", e.code, e.reason)
            return 400 <= e.code < 500
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log.warning("backend unreachable (%s) — queued", e)
            return False

    def send(self, payload: dict, path: str = "/api/logs") -> None:
        if not self.cfg.post:
            log.info("[dry run] %s %s", path, json.dumps(payload))
            return
        self.queue.append({"path": path, "payload": payload})
        self.drain()

    def drain(self) -> None:
        sent = 0
        while self.queue:
            item = self.queue[0]
            if not self._post(item["path"], item["payload"]):
                break
            self.queue.popleft()
            sent += 1
        if sent or self.queue:
            self._save_queue()


class PreviewSender:
    """Ships the live door view to the backend, on its own thread.

    Two rules keep this off the critical path:

      * One slot, newest wins. If the network is slow the camera loop
        overwrites the pending frame instead of waiting for it. A stalled
        upload can never stall recognition.
      * Nobody watching, nothing sent. The backend says whether a browser has
        asked for a frame in the last few seconds; when none has, this falls
        back to a cheap state poll every couple of seconds and the camera loop
        skips the JPEG encode entirely.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._slot: dict | None = None
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._wanted = False
        self._warned = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not (self.cfg.preview_enabled and self.cfg.post):
            return
        self._thread = threading.Thread(target=self._run, name="live-view", daemon=True)
        self._thread.start()

    def wanted(self) -> bool:
        return self._wanted

    def offer(self, image_b64: str, faces: list[dict], width: int, height: int) -> None:
        with self._lock:
            self._slot = {
                "image": image_b64,
                "faces": faces,
                "width": width,
                "height": height,
                "captured_at": datetime.now(timezone.utc).isoformat(),
            }
        self._wake.set()

    def _apply(self, reply: dict | None) -> None:
        if reply is None:
            if self._wanted and not self._warned:
                log.warning("backend unreachable — live view paused")
                self._warned = True
            self._wanted = False
            return
        self._warned = False
        self._wanted = bool(reply.get("wanted"))

    def _run(self) -> None:
        # Ask straight away rather than after the first wait, so opening the
        # live view in the browser shows a picture now and not in two seconds.
        self._apply(http_json(f"{self.cfg.api}/api/preview/state", self.cfg.api_token, timeout=3.0))

        while not self._stop.is_set():
            self._wake.wait(timeout=2.0)
            self._wake.clear()
            if self._stop.is_set():
                break

            with self._lock:
                frame, self._slot = self._slot, None

            if frame is not None:
                self._apply(http_json(f"{self.cfg.api}/api/preview", self.cfg.api_token, frame, timeout=3.0))
            else:
                self._apply(http_json(f"{self.cfg.api}/api/preview/state", self.cfg.api_token, timeout=3.0))

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()


def open_capture(source: str):
    import cv2

    cap = cv2.VideoCapture(int(source) if str(source).isdigit() else source)
    if not cap.isOpened():
        sys.exit(
            f"could not open camera source {source!r}.\n"
            "For a USB camera try 0 or 1; for an IP camera use the full RTSP URL."
        )
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always read the freshest frame
    return cap


def build_model(cfg: Config):
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        sys.exit("pip install insightface onnxruntime opencv-python-headless")
    app = FaceAnalysis(name=cfg.model, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(cfg.det_size, cfg.det_size))
    return app


def gallery_stamp() -> float:
    """mtime of embeddings.json, or 0. Changes when a guest is enrolled."""
    try:
        return EMBEDDINGS_FILE.stat().st_mtime
    except OSError:
        return 0.0


def handle_track(track, gallery, cooldown: Cooldown, sender: EventSender, cfg: Config) -> None:
    """One completed walk-past: identify it and log it."""
    if len(track.observations) < cfg.min_track_len:
        return  # a flicker, not a person

    best = track.best()
    if best.embedding is None:
        return
    if min(
        best.bbox[2] - best.bbox[0], best.bbox[3] - best.bbox[1]
    ) < cfg.min_face_px:
        return

    match = identify(best.embedding, gallery, cfg.threshold, cfg.margin)
    direction = track_direction(track, cfg.approach_means)

    if match.accepted and cfg.liveness_enabled and best.rgb_crop is not None:
        live = check_liveness(
            best.rgb_crop,
            blur_floor=cfg.liveness_blur_floor,
            chroma_low=cfg.liveness_chroma_low,
            chroma_high=cfg.liveness_chroma_high,
            glare_ceiling=cfg.liveness_glare_ceiling,
        )
        if not live.passed:
            log.info("%s matched but failed liveness (%s) — logging as unknown", match.name, live.reason)
            if cfg.log_unknowns:
                sender.send(
                    {
                        "event_id": uuid.uuid4().hex,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "best_score": round(match.score, 4),
                        "reason": f"liveness_{live.reason}",
                        "direction": direction,
                    },
                    path="/api/unknown",
                )
            return

    if not match.accepted:
        log.info(
            "unknown face (best %.2f, runner-up %.2f, %s)",
            match.score,
            match.runner_up,
            match.reason,
        )
        if cfg.log_unknowns:
            sender.send(
                {
                    "event_id": uuid.uuid4().hex,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "best_score": round(match.score, 4),
                    "reason": match.reason,
                    "direction": direction,
                },
                path="/api/unknown",
            )
        return

    if not cooldown.allows(match.guest_id):
        log.debug(
            "%s still in cooldown (%.0fs left)",
            match.name,
            cooldown.remaining(match.guest_id),
        )
        return

    cooldown.mark(match.guest_id)
    log.info(
        "%s  %.2f  direction=%s",
        match.name,
        match.score,
        direction or "toggle",
    )
    sender.send(
        {
            "event_id": uuid.uuid4().hex,
            "guest_id": match.guest_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "confidence": round(match.score, 4),
            # None means "you decide" — the backend falls back to toggling
            # the guest's last known state.
            "direction": direction,
            "source": "camera",
            "track_frames": len(track.observations),
        }
    )


def run(cfg: Config) -> int:
    import cv2

    gallery = load_gallery(EMBEDDINGS_FILE)
    gallery_seen = gallery_stamp()
    if not gallery:
        log.warning(
            "no enrolled guests in %s yet — watching anyway. Add a guest from "
            "the dashboard and this picks them up within %.0fs.",
            EMBEDDINGS_FILE,
            cfg.gallery_poll,
        )
    else:
        log.info("loaded %d enrolled guests", len(gallery))

    app = build_model(cfg)
    cap = open_capture(cfg.source)
    tracker = Tracker()
    cooldown = Cooldown(cfg.cooldown)
    sender = EventSender(cfg)

    gate = MotionGate(
        pixel_delta=cfg.motion_pixel_delta,
        min_changed=cfg.motion_min_changed,
        hold_frames=cfg.motion_hold_frames,
        force_every=cfg.motion_force_every,
    )
    preview = PreviewSender(cfg)
    preview.start()

    stopping = False

    def stop(_sig, _frm):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    frames = 0
    t0 = time.time()
    misses = 0
    frame_interval = 1.0 / cfg.max_fps if cfg.max_fps > 0 else 0.0
    preview_interval = 1.0 / cfg.preview_fps if cfg.preview_fps > 0 else 0.0
    next_frame_at = 0.0
    last_preview_at = 0.0
    gallery_checked_at = time.time()
    boxes: list[dict] = []
    boxes_at = 0.0

    while not stopping:
        # --- pacing: don't burn cycles reading faster than we process ------
        now = time.time()
        if frame_interval and now < next_frame_at:
            time.sleep(min(next_frame_at - now, 0.05))
            continue
        next_frame_at = time.time() + frame_interval

        ok, frame = cap.read()
        if not ok:
            misses += 1
            if misses > 60:
                log.error("camera stopped delivering frames — reopening")
                cap.release()
                time.sleep(2)
                cap = open_capture(cfg.source)
                misses = 0
            time.sleep(0.05)
            continue
        misses = 0
        frames += 1
        now = time.time()

        # --- a guest enrolled from the browser? pick them up ---------------
        if now - gallery_checked_at >= cfg.gallery_poll:
            gallery_checked_at = now
            stamp = gallery_stamp()
            if stamp != gallery_seen:
                gallery_seen = stamp
                gallery = load_gallery(EMBEDDINGS_FILE)
                log.info("roster changed — now matching %d guests", len(gallery))

        scale = cfg.detect_width / frame.shape[1]
        small = (
            cv2.resize(frame, (cfg.detect_width, int(frame.shape[0] * scale)))
            if scale < 1
            else frame
        )
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        # --- motion gate: the cheap question before the expensive one ------
        if cfg.motion_enabled:
            mw = cfg.motion_width
            mh = max(1, int(gray.shape[0] * (mw / gray.shape[1])))
            run_detect = gate.update(cv2.resize(gray, (mw, mh)))
        else:
            run_detect = True

        observations = []
        if run_detect:
            for face in app.get(small):
                x1, y1, x2, y2 = (float(v) for v in face.bbox)
                crop = gray[max(0, int(y1)) : int(y2), max(0, int(x1)) : int(x2)]
                if crop.size == 0:
                    continue
                rgb_crop = None
                if cfg.liveness_enabled:
                    bgr_crop = small[max(0, int(y1)) : int(y2), max(0, int(x1)) : int(x2)]
                    if bgr_crop.size > 0:
                        rgb_crop = bgr_crop[:, :, ::-1].copy()  # BGR -> RGB
                observations.append(
                    Observation(
                        bbox=(x1, y1, x2, y2),
                        sharpness=sharpness(crop),
                        embedding=l2_normalize(face.normed_embedding.astype(np.float32)),
                        rgb_crop=rgb_crop,
                    )
                )

        # A skipped frame is a frame with no faces in it, which is exactly
        # what the tracker should be told: tracks still age out on schedule.
        for finished in tracker.update(observations):
            handle_track(finished, gallery, cooldown, sender, cfg)

        # --- live view -----------------------------------------------------
        if preview.wanted() and now - last_preview_at >= preview_interval:
            last_preview_at = now
            if run_detect:
                # Free: every visible face was already embedded this frame, so
                # naming them is a few dot products against a 20-row gallery.
                boxes = build_overlay(
                    observations, gallery, small.shape[1], small.shape[0],
                    cfg.threshold, cfg.margin,
                )
                boxes_at = now
            elif now - boxes_at > 1.0:
                boxes = []  # gate skipped and the last read is stale — clear

            pw = cfg.preview_width
            pv = (
                cv2.resize(small, (pw, max(1, int(small.shape[0] * (pw / small.shape[1])))))
                if pw < small.shape[1]
                else small
            )
            encoded, buf = cv2.imencode(
                ".jpg", pv, [int(cv2.IMWRITE_JPEG_QUALITY), cfg.preview_quality]
            )
            if encoded:
                preview.offer(
                    base64.b64encode(buf.tobytes()).decode("ascii"),
                    boxes,
                    pv.shape[1],
                    pv.shape[0],
                )

        if frames % 300 == 0:
            sender.drain()  # retry anything queued while the backend was down
            log.info(
                "%d frames, %.1f fps, %.0f%% skipped by motion gate, %d tracks, %d queued",
                frames,
                frames / (time.time() - t0),
                gate.skip_ratio * 100,
                len(tracker.tracks),
                len(sender.queue),
            )

        if cfg.window:
            for o in observations:
                x1, y1, x2, y2 = (int(v) for v in o.bbox)
                cv2.rectangle(small, (x1, y1), (x2, y2), (0, 200, 120), 2)
            cv2.imshow("entrance", small)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    for finished in tracker.flush():
        handle_track(finished, gallery, cooldown, sender, cfg)
    sender.drain()
    preview.stop()
    cap.release()
    if cfg.window:
        cv2.destroyAllWindows()
    log.info(
        "stopped after %d frames (%.0f%% skipped by the motion gate); %d events still queued",
        frames,
        gate.skip_ratio * 100,
        len(sender.queue),
    )
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", help="camera index, video file or RTSP URL")
    p.add_argument("--no-post", action="store_true", help="log events instead of sending them")
    p.add_argument(
        "--window",
        "--preview",
        dest="window",
        action="store_true",
        help="show a local camera window (needs a display; the warden's live view is in the browser)",
    )
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    return run(Config(args))


if __name__ == "__main__":
    raise SystemExit(main())
