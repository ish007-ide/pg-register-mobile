"""End-to-end test of the camera loop, with no camera and no model.

Stubs OpenCV and InsightFace, then plays a scripted corridor through the real
service.run(): empty, someone walks in, empty again. Proves the parts that
unit tests can't reach — that the motion gate skips an idle doorway, that a
walk-past still produces exactly one register entry, and that the live view
payload is shaped the way the browser expects.

    python3 test_service.py
"""

from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import types
from argparse import Namespace
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# The scripted corridor
# --------------------------------------------------------------------------

# A doorway is idle the overwhelming majority of the time. Short idle stretches
# would flatter nothing and understate the gate: the startup hold window would
# dominate the count. 150 idle frames either side of a walk-past is still far
# tamer than the real thing, where idle runs for hours.
EMPTY_BEFORE = 150
WALK_PAST = 14
EMPTY_AFTER = 150
TOTAL = EMPTY_BEFORE + WALK_PAST + EMPTY_AFTER

# Frames are small and the noise buffer is precomputed — this test runs the
# loop hundreds of times over and shouldn't spend its life in numpy.
FRAME_W, FRAME_H = 640, 360
DETECT_W = 320                      # frames get downscaled to this by the service
SCALE = DETECT_W / FRAME_W

RNG = np.random.default_rng(3)
D = 512

NOISE = RNG.normal(scale=1.2, size=(FRAME_H, FRAME_W, 3))

GUEST_ID = "abc123"
GUEST_NAME = "Asha Kulkarni"
GUEST_VEC = RNG.normal(size=D).astype(np.float32)
GUEST_VEC /= np.linalg.norm(GUEST_VEC)


def frame_for(i: int) -> np.ndarray:
    """A static corridor, with a person crossing it in the middle stretch."""
    img = 110.0 + np.roll(NOISE, i * 37, axis=1)   # sensor noise, always there

    box = person_visible(i)
    if box is not None:
        x1, y1, x2, y2 = (int(v / SCALE) for v in box)
        img[y1:y2, x1:x2] = 40.0
    return np.clip(img, 0, 255).astype(np.uint8)


def person_visible(i: int) -> tuple[float, float, float, float] | None:
    """The bbox the stubbed detector reports, in detect space (320 wide).

    The box grows as they approach, which is what track_direction reads as
    "walking in", and starts above MIN_FACE_PX so it isn't discarded.
    """
    if not (EMPTY_BEFORE <= i < EMPTY_BEFORE + WALK_PAST):
        return None
    step = i - EMPTY_BEFORE
    size = 62.0 + step * 8.0
    x = 40.0 + step * 6.0
    return (x, 30.0, x + size, 30.0 + size)


# --------------------------------------------------------------------------
# Stubs
# --------------------------------------------------------------------------


def nearest_resize(img: np.ndarray, dsize) -> np.ndarray:
    w, h = dsize
    ys = (np.arange(h) * (img.shape[0] / h)).astype(int).clip(0, img.shape[0] - 1)
    xs = (np.arange(w) * (img.shape[1] / w)).astype(int).clip(0, img.shape[1] - 1)
    return img[ys][:, xs]


def make_cv2_stub(state: dict):
    cv2 = types.ModuleType("cv2")
    cv2.COLOR_BGR2GRAY = 6
    cv2.CAP_PROP_BUFFERSIZE = 38
    cv2.IMWRITE_JPEG_QUALITY = 1

    cv2.resize = lambda img, dsize, *a, **k: nearest_resize(img, dsize)
    cv2.cvtColor = lambda img, code: img.mean(axis=2).astype(np.uint8)
    cv2.imencode = lambda ext, img, params=None: (
        True,
        np.frombuffer(b"\xff\xd8\xff" + img.tobytes()[:64], dtype=np.uint8),
    )
    cv2.rectangle = lambda *a, **k: None
    cv2.imshow = lambda *a, **k: None
    cv2.waitKey = lambda *a, **k: 0
    cv2.destroyAllWindows = lambda: None

    class FakeCapture:
        def __init__(self, *_a):
            self.i = 0

        def isOpened(self):
            return True

        def set(self, *_a):
            return True

        def read(self):
            if self.i >= TOTAL:
                # End of the scripted clip: ask the service to shut down the
                # same way Ctrl-C would.
                os.kill(os.getpid(), signal.SIGINT)
                return False, None
            img = frame_for(self.i)
            state["frame_index"] = self.i
            self.i += 1
            return True, img

        def release(self):
            state["released"] = True

    cv2.VideoCapture = FakeCapture
    return cv2


class FakeFace:
    def __init__(self, bbox, vec):
        self.bbox = np.asarray(bbox, dtype=np.float32)
        self.normed_embedding = vec.astype(np.float32)


def make_model(state: dict):
    class FakeModel:
        def get(self, _img):
            state["detector_calls"] += 1
            bbox = person_visible(state["frame_index"])
            if bbox is None:
                return []
            noisy = GUEST_VEC + RNG.normal(scale=0.04, size=D).astype(np.float32)
            return [FakeFace(bbox, noisy / np.linalg.norm(noisy))]

    return FakeModel()


# --------------------------------------------------------------------------


def run_scenario(env_overrides: dict, force_live_view: bool = False) -> dict:
    state = {"frame_index": 0, "detector_calls": 0, "events": [], "previews": [],
             "offered": []}

    sys.modules["cv2"] = make_cv2_stub(state)
    import service

    tmp = Path(tempfile.mkdtemp(prefix="pgtest_"))
    (tmp / "embeddings.json").write_text(
        json.dumps(
            [{"id": GUEST_ID, "name": GUEST_NAME, "room_no": "204",
              "embeddings": [GUEST_VEC.tolist()]}]
        ),
        encoding="utf-8",
    )

    original = {
        "DATA": service.DATA,
        "EMBEDDINGS_FILE": service.EMBEDDINGS_FILE,
        "QUEUE_FILE": service.QUEUE_FILE,
        "build_model": service.build_model,
        "http_json": service.http_json,
        "offer": service.PreviewSender.offer,
        "wanted": service.PreviewSender.wanted,
        "_post": service.EventSender._post,
        "env": {k: os.environ.get(k) for k in env_overrides},
    }

    service.DATA = tmp
    service.EMBEDDINGS_FILE = tmp / "embeddings.json"
    service.QUEUE_FILE = tmp / "pending_events.json"
    service.build_model = lambda cfg: make_model(state)

    def fake_post(self, path, payload):
        state["events"].append({"path": path, "payload": payload})
        return True

    def fake_http_json(url, token, payload=None, timeout=4.0):
        if payload is not None:
            state["previews"].append(payload)
        return {"wanted": True}

    service.EventSender._post = fake_post
    service.http_json = fake_http_json

    # Record what the camera loop hands over. Asserting here rather than on
    # what the background thread managed to POST keeps the test off the
    # thread scheduler: whether the sender has flushed by the time the clip
    # ends is a timing question, and not the one these tests are asking.
    real_offer = service.PreviewSender.offer

    def spy_offer(self, image, faces, width, height):
        state["offered"].append(
            {"image": image, "faces": faces, "width": width, "height": height}
        )
        return real_offer(self, image, faces, width, height)

    service.PreviewSender.offer = spy_offer
    if force_live_view:
        service.PreviewSender.wanted = lambda self: True

    os.environ.update({k: str(v) for k, v in env_overrides.items()})

    try:
        cfg = service.Config(Namespace(source="0", no_post=False, window=False))
        service.run(cfg)
    finally:
        service.DATA = original["DATA"]
        service.EMBEDDINGS_FILE = original["EMBEDDINGS_FILE"]
        service.QUEUE_FILE = original["QUEUE_FILE"]
        service.build_model = original["build_model"]
        service.http_json = original["http_json"]
        service.EventSender._post = original["_post"]
        service.PreviewSender.offer = original["offer"]
        service.PreviewSender.wanted = original["wanted"]
        for k, v in original["env"].items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    return state


BASE_ENV = {
    "MAX_FPS": "0",
    "DETECT_WIDTH": "320",            # no pacing sleep, so the test runs instantly
    "LIVE_VIEW_FPS": "1000",
    "COOLDOWN_SECONDS": "120",
    "GALLERY_POLL_SECONDS": "999",
    "MATCH_THRESHOLD": "0.42",
    "MATCH_MARGIN": "0.06",
    "MIN_FACE_PX": "60",
    "LOG_UNKNOWNS": "1",
}


def test_walk_past_produces_exactly_one_register_entry():
    state = run_scenario({**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "0"})

    logs = [e for e in state["events"] if e["path"] == "/api/logs"]
    assert len(logs) == 1, f"expected one movement, got {len(logs)}"

    payload = logs[0]["payload"]
    assert payload["guest_id"] == GUEST_ID
    assert payload["direction"] == "in", "a face growing larger means walking in"
    assert payload["confidence"] > 0.42
    assert payload["source"] == "camera"
    assert payload["event_id"]


def test_motion_gate_keeps_most_frames_away_from_the_detector():
    gated = run_scenario({**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "0"})
    ungated = run_scenario({**BASE_ENV, "MOTION_GATE": "0", "LIVE_VIEW": "0"})

    assert ungated["detector_calls"] == TOTAL, "ungated should detect every frame"
    saved = 1 - gated["detector_calls"] / ungated["detector_calls"]
    assert saved > 0.65, f"motion gate only saved {saved:.0%} of detections"

    # and it must not have cost us the movement
    assert len([e for e in gated["events"] if e["path"] == "/api/logs"]) == 1


def test_gate_does_not_change_what_lands_in_the_register():
    gated = run_scenario({**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "0"})
    ungated = run_scenario({**BASE_ENV, "MOTION_GATE": "0", "LIVE_VIEW": "0"})

    def shape(state):
        return [
            (e["path"], e["payload"].get("guest_id"), e["payload"].get("direction"))
            for e in state["events"]
        ]

    assert shape(gated) == shape(ungated)


def test_live_view_payload_is_shaped_for_the_browser():
    state = run_scenario(
        {**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "1"}, force_live_view=True
    )
    assert state["offered"], "nothing was sent to the live view"

    for payload in state["offered"]:
        assert isinstance(payload["image"], str) and payload["image"]
        assert payload["width"] > 0 and payload["height"] > 0
        for box in payload["faces"]:
            for key in ("x", "y", "w", "h"):
                assert 0.0 <= box[key] <= 1.0, f"{key} out of frame: {box[key]}"
            assert isinstance(box["name"], str)
            assert isinstance(box["known"], bool)

    named = [b for p in state["offered"] for b in p["faces"] if b["known"]]
    assert named, "the enrolled guest was never named on the live view"
    assert all(b["name"] == GUEST_NAME for b in named)


def test_live_view_shows_an_empty_doorway_as_empty():
    state = run_scenario(
        {**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "1"}, force_live_view=True
    )
    # Frames still stream while nobody is there; they just carry no boxes.
    assert any(p["faces"] == [] for p in state["offered"])


def test_live_view_off_sends_nothing():
    state = run_scenario({**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "0"})
    assert state["offered"] == []
    assert state["previews"] == []


def test_watching_the_live_view_does_not_change_the_register():
    watched = run_scenario(
        {**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "1"}, force_live_view=True
    )
    unwatched = run_scenario({**BASE_ENV, "MOTION_GATE": "1", "LIVE_VIEW": "0"})

    def shape(state):
        return [
            (e["path"], e["payload"].get("guest_id"), e["payload"].get("direction"))
            for e in state["events"]
        ]

    assert shape(watched) == shape(unwatched)
    assert len(shape(watched)) == 1


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
