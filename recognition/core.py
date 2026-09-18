"""Pure logic for the PG entry/exit recognition service.

Deliberately free of camera, model and network dependencies so it can be unit
tested without a webcam, without insightface installed and without a running
backend. service.py wires this to OpenCV + InsightFace + the Express API.
"""

from __future__ import annotations

import json
import math
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# --------------------------------------------------------------------------
# Gallery + matching
# --------------------------------------------------------------------------


@dataclass
class GalleryEntry:
    guest_id: str
    name: str
    room_no: str
    # (k, d) — one row per enrollment photo, L2-normalised. We keep every
    # enrollment embedding rather than averaging them: a single bad reference
    # photo drags an averaged vector away from the guest's true centroid,
    # whereas max-similarity just ignores it.
    embeddings: np.ndarray


def l2_normalize(v: np.ndarray) -> np.ndarray:
    """Normalise a vector or a stack of row vectors to unit length."""
    v = np.asarray(v, dtype=np.float32)
    if v.ndim == 1:
        n = np.linalg.norm(v)
        return v / n if n > 0 else v
    n = np.linalg.norm(v, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return v / n


def load_gallery(embeddings_path: str | Path) -> list[GalleryEntry]:
    """Read embeddings.json written by enroll.py."""
    path = Path(embeddings_path)
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    gallery: list[GalleryEntry] = []
    for rec in raw:
        vecs = np.asarray(rec["embeddings"], dtype=np.float32)
        if vecs.ndim == 1:
            vecs = vecs[None, :]
        if vecs.size == 0:
            continue
        gallery.append(
            GalleryEntry(
                guest_id=rec["id"],
                name=rec.get("name", ""),
                room_no=str(rec.get("room_no", "")),
                embeddings=l2_normalize(vecs),
            )
        )
    return gallery


@dataclass
class Match:
    guest_id: str | None
    name: str | None
    score: float
    runner_up: float
    accepted: bool
    reason: str


def identify(
    probe: np.ndarray,
    gallery: Sequence[GalleryEntry],
    threshold: float = 0.42,
    margin: float = 0.06,
) -> Match:
    """1:N match of one face embedding against the enrolled gallery.

    Two gates, both of which must pass:
      * absolute  — best cosine similarity must clear `threshold`
      * relative  — best must beat the runner-up guest by `margin`

    The margin gate is what keeps look-alikes and non-enrolled visitors out.
    With only 20 guests the absolute threshold alone is loose enough that a
    stranger will occasionally clear it; requiring a clear winner as well
    turns most of those into "unknown" instead of a wrong name in the register.
    """
    if not len(gallery):
        return Match(None, None, 0.0, 0.0, False, "empty_gallery")

    probe = l2_normalize(probe)
    per_guest = np.array([float(np.max(g.embeddings @ probe)) for g in gallery])

    order = np.argsort(per_guest)[::-1]
    best_i = int(order[0])
    best = float(per_guest[best_i])
    runner_up = float(per_guest[order[1]]) if len(order) > 1 else 0.0
    entry = gallery[best_i]

    if best < threshold:
        return Match(None, None, best, runner_up, False, "below_threshold")
    if best - runner_up < margin:
        return Match(None, None, best, runner_up, False, "ambiguous")
    return Match(entry.guest_id, entry.name, best, runner_up, True, "ok")


# --------------------------------------------------------------------------
# Face quality
# --------------------------------------------------------------------------


def sharpness(gray_crop: np.ndarray) -> float:
    """Variance-of-Laplacian. Higher is sharper.

    Implemented with numpy rather than cv2 so the core stays importable
    without OpenCV. Used to pick the single best frame out of a track
    instead of embedding every blurry frame of someone mid-stride.
    """
    g = np.asarray(gray_crop, dtype=np.float32)
    if g.ndim == 3:
        g = g.mean(axis=2)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = (
        -4.0 * g[1:-1, 1:-1]
        + g[:-2, 1:-1]
        + g[2:, 1:-1]
        + g[1:-1, :-2]
        + g[1:-1, 2:]
    )
    return float(lap.var())


def chroma_texture_score(rgb_crop: np.ndarray) -> float:
    """Average std-dev of the Cr/Cb chroma channels.

    A printed photo or a phone/tablet screen held up to the camera tends to
    have flatter, more uniform chroma than skin under real light. This is a
    coarse signal, not proof of anything on its own — see check_liveness.
    Implemented with the standard BT.601 Y'CrCb formula rather than cv2 so
    it stays importable without OpenCV; service.py feeds it an RGB crop.
    """
    rgb = np.asarray(rgb_crop, dtype=np.float32)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.size == 0:
        return 0.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cr = (r - y) * 0.713 + 128.0
    cb = (b - y) * 0.564 + 128.0
    return float((np.std(cr) + np.std(cb)) / 2.0)


def specular_ratio(crop: np.ndarray, bright_thresh: float = 240.0) -> float:
    """Fraction of near-white pixels in a crop — screen glare or flash-off-print."""
    g = np.asarray(crop, dtype=np.float32)
    if g.ndim == 3:
        g = g.mean(axis=2)
    if g.size == 0:
        return 0.0
    return float(np.mean(g >= bright_thresh))


@dataclass
class LivenessResult:
    passed: bool
    sharpness: float
    chroma: float
    glare: float
    reason: str


def check_liveness(
    rgb_crop: np.ndarray,
    blur_floor: float = 60.0,
    chroma_low: float = 5.0,
    chroma_high: float = 32.0,
    glare_ceiling: float = 0.12,
) -> LivenessResult:
    """Passive, opt-in anti-spoof filter: rejects the obviously-flat or glared.

    This is a coarse filter, not a real anti-spoofing model, and it is off by
    default (see LIVENESS_ENABLED in .env.example and the README) — someone
    walking past without stopping can't be challenged to blink or turn, and
    the threat this defends against (a printed photo held up to fake a
    sign-in) is a narrow one for a doorway register. It catches the easy
    cases — a flat screen replay, a print that glares — and lets everything
    else through; treat a failure here as "log as unknown", never as a
    security guarantee.
    """
    gray = rgb_crop.mean(axis=2) if rgb_crop.ndim == 3 else rgb_crop
    sharp = sharpness(gray)
    chroma = chroma_texture_score(rgb_crop) if rgb_crop.ndim == 3 else 0.0
    glare = specular_ratio(rgb_crop)

    if sharp < blur_floor:
        return LivenessResult(False, sharp, chroma, glare, "too_blurry")
    if rgb_crop.ndim == 3 and not (chroma_low <= chroma <= chroma_high):
        return LivenessResult(False, sharp, chroma, glare, "flat_chroma")
    if glare > glare_ceiling:
        return LivenessResult(False, sharp, chroma, glare, "glare")
    return LivenessResult(True, sharp, chroma, glare, "ok")


# --------------------------------------------------------------------------
# Tracking
# --------------------------------------------------------------------------


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection-over-union of two (x1, y1, x2, y2) boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def box_area(b: Sequence[float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


@dataclass
class Observation:
    """One detection of one face in one frame."""

    bbox: tuple[float, float, float, float]
    sharpness: float
    embedding: np.ndarray | None = None
    ts: float = field(default_factory=time.time)
    # Small RGB crop, only kept when LIVENESS_ENABLED — used once, for the
    # track's best() frame, by check_liveness. None otherwise: storing a
    # color crop per observation for every track adds up on a mini PC.
    rgb_crop: np.ndarray | None = None


@dataclass
class Track:
    track_id: str
    observations: list[Observation] = field(default_factory=list)
    last_seen_frame: int = 0

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return self.observations[-1].bbox

    def best(self) -> Observation:
        """Sharpest, largest observation — the one worth embedding."""
        return max(
            self.observations,
            key=lambda o: o.sharpness * math.sqrt(max(box_area(o.bbox), 1.0)),
        )


def track_direction(
    track: Track, approach_means: str = "in", min_ratio: float = 1.15
) -> str | None:
    """Infer walking direction from how the face box grows across the track.

    A face getting bigger frame over frame is walking toward the camera.
    Returns "in"/"out", or None when the evidence is too weak to use — in
    which case the caller should fall back to toggling the last known state.
    """
    if len(track.observations) < 4:
        return None
    areas = [box_area(o.bbox) for o in track.observations]
    third = max(1, len(areas) // 3)
    first = float(np.mean(areas[:third]))
    last = float(np.mean(areas[-third:]))
    if first <= 0 or last <= 0:
        return None

    away = "out" if approach_means == "in" else "in"
    if last / first >= min_ratio:
        return approach_means
    if first / last >= min_ratio:
        return away
    return None


class Tracker:
    """Greedy IoU tracker.

    Groups detections into one "person walked past" event so the service
    embeds once per pass, on the best frame, instead of once per frame.
    """

    def __init__(self, iou_threshold: float = 0.3, max_missed_frames: int = 8):
        self.iou_threshold = iou_threshold
        self.max_missed_frames = max_missed_frames
        self.tracks: dict[str, Track] = {}
        self.frame_no = 0

    def update(self, observations: Iterable[Observation]) -> list[Track]:
        """Feed one frame's detections. Returns tracks that just ended."""
        self.frame_no += 1
        unmatched = list(observations)

        for track in self.tracks.values():
            if not unmatched:
                break
            scores = [(iou(track.bbox, o.bbox), i) for i, o in enumerate(unmatched)]
            best_score, best_i = max(scores, key=lambda t: t[0])
            if best_score >= self.iou_threshold:
                track.observations.append(unmatched.pop(best_i))
                track.last_seen_frame = self.frame_no

        for obs in unmatched:
            tid = uuid.uuid4().hex[:12]
            self.tracks[tid] = Track(tid, [obs], self.frame_no)

        finished = [
            t
            for t in self.tracks.values()
            if self.frame_no - t.last_seen_frame > self.max_missed_frames
        ]
        for t in finished:
            del self.tracks[t.track_id]
        return finished

    def flush(self) -> list[Track]:
        finished = list(self.tracks.values())
        self.tracks.clear()
        return finished


# --------------------------------------------------------------------------
# Cooldown
# --------------------------------------------------------------------------


class Cooldown:
    """Per-guest rate limit, so lingering in frame can't spam the register."""

    def __init__(self, seconds: float = 120.0):
        self.seconds = seconds
        self._last: dict[str, float] = {}

    def allows(self, guest_id: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        last = self._last.get(guest_id)
        return last is None or (now - last) >= self.seconds

    def mark(self, guest_id: str, now: float | None = None) -> None:
        self._last[guest_id] = time.time() if now is None else now

    def remaining(self, guest_id: str, now: float | None = None) -> float:
        now = time.time() if now is None else now
        last = self._last.get(guest_id)
        if last is None:
            return 0.0
        return max(0.0, self.seconds - (now - last))


# --------------------------------------------------------------------------
# Motion gate
# --------------------------------------------------------------------------


class MotionGate:
    """Skip face detection while the doorway is empty.

    This is the single biggest CPU saving available on a fanless mini PC.
    Detection is ~100ms a frame; a frame difference on an 80x60 thumbnail is
    well under a millisecond. A PG doorway has nobody in it for the large
    majority of the day, so gating detection on "did anything move" drops the
    idle load by roughly an order of magnitude and leaves full frame rate for
    the seconds that actually matter.

    Three ways a frame gets detected:
      * motion now      — enough pixels changed since the last frame
      * hold window     — motion recently, so keep looking for a moment; this
                          is what catches someone who stops dead at the door
      * forced sweep    — every `force_every` frames regardless, so a person
                          standing perfectly still can never be invisible

    Deliberately free of OpenCV: service.py hands in an already-downscaled
    grayscale frame, and the tests hand in numpy arrays.
    """

    def __init__(
        self,
        pixel_delta: float = 8.0,
        min_changed: float = 0.0035,
        hold_frames: int = 18,
        force_every: int = 24,
    ):
        self.pixel_delta = pixel_delta
        self.min_changed = min_changed
        self.hold_frames = hold_frames
        self.force_every = force_every
        self._prev: np.ndarray | None = None
        self._hold = 0
        self._since_forced = 0
        self.detected = 0
        self.skipped = 0

    def _detect(self) -> bool:
        self._since_forced = 0
        self.detected += 1
        return True

    def update(self, small_gray: np.ndarray) -> bool:
        """Feed one downscaled gray frame. True = run detection on it."""
        cur = np.asarray(small_gray, dtype=np.float32)
        prev, self._prev = self._prev, cur
        self._since_forced += 1

        # First frame, or the camera changed resolution mid-run.
        if prev is None or prev.shape != cur.shape:
            self._hold = self.hold_frames
            return self._detect()

        changed = float(np.mean(np.abs(cur - prev) > self.pixel_delta))

        if changed >= self.min_changed:
            self._hold = self.hold_frames
            return self._detect()
        if self._hold > 0:
            self._hold -= 1
            return self._detect()
        if self._since_forced >= self.force_every:
            return self._detect()

        self.skipped += 1
        return False

    @property
    def skip_ratio(self) -> float:
        """Share of frames that never reached the detector. Higher is cheaper."""
        total = self.detected + self.skipped
        return self.skipped / total if total else 0.0


# --------------------------------------------------------------------------
# Live overlay
# --------------------------------------------------------------------------


def build_overlay(
    observations: Sequence[Observation],
    gallery: Sequence[GalleryEntry],
    frame_w: int,
    frame_h: int,
    threshold: float = 0.42,
    margin: float = 0.06,
) -> list[dict]:
    """Label boxes for the live door view — the name over the face.

    Costs essentially nothing: the embedding for every visible face was
    already computed by the detector this frame, so labelling is a handful of
    dot products against a 20-guest gallery. What it must NOT do is write to
    the register — that still happens once per track, on the sharpest frame,
    in handle_track. This is a read-out for the person watching the screen.

    Coordinates come back as fractions of the frame so the browser can scale
    them to whatever size it draws the picture at.
    """
    if frame_w <= 0 or frame_h <= 0:
        return []

    boxes = []
    for obs in observations:
        x1, y1, x2, y2 = obs.bbox
        name, score, known = "Looking\u2026", None, False

        if obs.embedding is not None and len(gallery):
            match = identify(obs.embedding, gallery, threshold, margin)
            score = round(match.score, 3)
            if match.accepted:
                name, known = match.name, True
            else:
                name = "Not recognised"

        boxes.append(
            {
                "x": max(0.0, min(1.0, x1 / frame_w)),
                "y": max(0.0, min(1.0, y1 / frame_h)),
                "w": max(0.0, min(1.0, (x2 - x1) / frame_w)),
                "h": max(0.0, min(1.0, (y2 - y1) / frame_h)),
                "name": name,
                "score": score,
                "known": known,
            }
        )
    return boxes
