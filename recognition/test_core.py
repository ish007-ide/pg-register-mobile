"""Tests for the recognition core. Run: python3 -m pytest recognition/test_core.py
or simply: python3 recognition/test_core.py
"""

import json
import tempfile
from pathlib import Path

import numpy as np

from core import (
    Cooldown,
    GalleryEntry,
    MotionGate,
    Observation,
    Track,
    Tracker,
    build_overlay,
    check_liveness,
    chroma_texture_score,
    identify,
    iou,
    l2_normalize,
    load_gallery,
    sharpness,
    specular_ratio,
    track_direction,
)

RNG = np.random.default_rng(7)
D = 512


def fake_person(jitter=0.0, base=None):
    v = RNG.normal(size=D).astype(np.float32) if base is None else base.copy()
    if jitter:
        v = v + RNG.normal(scale=jitter, size=D).astype(np.float32)
    return l2_normalize(v)


def build_gallery(n=20):
    entries = []
    bases = []
    for i in range(n):
        base = fake_person()
        bases.append(base)
        photos = np.stack([fake_person(jitter=0.045, base=base) for _ in range(4)])
        entries.append(GalleryEntry(f"g{i}", f"Guest {i}", str(100 + i), l2_normalize(photos)))
    return entries, bases


def test_identify_matches_enrolled_guest():
    gallery, bases = build_gallery()
    probe = fake_person(jitter=0.045, base=bases[5])
    m = identify(probe, gallery)
    assert m.accepted, m.reason
    assert m.guest_id == "g5"
    assert m.score > m.runner_up


def test_identify_rejects_stranger():
    gallery, _ = build_gallery()
    stranger = fake_person()
    m = identify(stranger, gallery)
    assert not m.accepted
    assert m.guest_id is None
    assert m.reason in ("below_threshold", "ambiguous")


def test_identify_rejects_ambiguous_tie():
    base = fake_person()
    twin_a = GalleryEntry("a", "A", "1", l2_normalize(base[None, :]))
    twin_b = GalleryEntry("b", "B", "2", l2_normalize(base[None, :]))
    m = identify(base, [twin_a, twin_b], threshold=0.4, margin=0.06)
    assert not m.accepted
    assert m.reason == "ambiguous"


def test_identify_empty_gallery():
    m = identify(fake_person(), [])
    assert not m.accepted and m.reason == "empty_gallery"


def test_one_bad_reference_photo_cannot_degrade_the_match():
    """Why we keep every enrollment embedding instead of averaging them.

    Averaging is fine when all reference photos are good — on clean inputs it
    can even edge out max-similarity, because noise cancels. The problem is
    that it has no floor: one wrong-person or badly-lit photo drags the stored
    centroid away from the guest and quietly lowers every future match. Taking
    the max over stored embeddings is immune to that by construction, which is
    the property worth having when enrollment is done by hand on a phone.
    """
    base = fake_person()
    good = np.stack([fake_person(jitter=0.045, base=base) for _ in range(3)])
    bad = fake_person()  # a photo of the wrong person, or an unusable one
    with_bad = l2_normalize(np.vstack([good, bad[None, :]]))

    others, _ = build_gallery(19)
    probe = fake_person(jitter=0.045, base=base)

    def score(embs):
        return identify(probe, [GalleryEntry("t", "T", "1", embs)] + others).score

    kept_clean = score(l2_normalize(good))
    kept_dirty = score(with_bad)
    avg_clean = score(l2_normalize(good.mean(axis=0)[None, :]))
    avg_dirty = score(l2_normalize(with_bad.mean(axis=0)[None, :]))

    assert kept_dirty == kept_clean  # bad photo is simply never selected
    assert avg_dirty < avg_clean  # bad photo permanently pollutes the centroid


def test_load_gallery_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "embeddings.json"
        p.write_text(
            json.dumps(
                [{"id": "g1", "name": "Asha", "room_no": "204", "embeddings": [[1.0, 0.0, 0.0]]}]
            )
        )
        g = load_gallery(p)
        assert len(g) == 1 and g[0].guest_id == "g1" and g[0].embeddings.shape == (1, 3)
    assert load_gallery(Path(d) / "nope.json") == []


def test_iou():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert abs(iou((0, 0, 10, 10), (5, 0, 15, 10)) - (50 / 150)) < 1e-6


def test_sharpness_ranks_blur_correctly():
    sharp = RNG.normal(scale=60, size=(40, 40)).astype(np.float32)
    blurred = np.repeat(np.repeat(sharp[::4, ::4], 4, axis=0), 4, axis=1)
    assert sharpness(sharp) > sharpness(blurred)
    assert sharpness(np.zeros((2, 2))) == 0.0


def test_tracker_groups_one_walk_past_into_one_track():
    tr = Tracker(max_missed_frames=3)
    box = [100.0, 100.0, 140.0, 140.0]
    for _ in range(10):
        box = [box[0] + 3, box[1], box[2] + 5, box[3] + 2]
        assert tr.update([Observation(tuple(box), 100.0)]) == []
    assert len(tr.tracks) == 1
    for _ in range(4):
        finished = tr.update([])
    assert len(finished) == 1
    assert len(finished[0].observations) == 10


def test_tracker_separates_two_people():
    tr = Tracker()
    for _ in range(5):
        tr.update(
            [
                Observation((10.0, 10.0, 50.0, 50.0), 100.0),
                Observation((300.0, 10.0, 340.0, 50.0), 100.0),
            ]
        )
    assert len(tr.tracks) == 2


def test_direction_from_growing_and_shrinking_box():
    growing = Track("t", [Observation((0.0, 0.0, 20.0 + 6 * i, 20.0 + 6 * i), 1.0) for i in range(8)])
    shrinking = Track("t", [Observation((0.0, 0.0, 80.0 - 6 * i, 80.0 - 6 * i), 1.0) for i in range(8)])
    steady = Track("t", [Observation((0.0, 0.0, 40.0, 40.0), 1.0) for _ in range(8)])

    assert track_direction(growing) == "in"
    assert track_direction(shrinking) == "out"
    assert track_direction(steady) is None
    assert track_direction(Track("t", [Observation((0.0, 0.0, 10.0, 10.0), 1.0)])) is None
    # camera mounted facing the other way
    assert track_direction(growing, approach_means="out") == "out"


def test_track_best_prefers_sharp_and_large():
    t = Track(
        "t",
        [
            Observation((0.0, 0.0, 100.0, 100.0), 5.0),
            Observation((0.0, 0.0, 90.0, 90.0), 900.0),
            Observation((0.0, 0.0, 20.0, 20.0), 950.0),
        ],
    )
    assert t.best().sharpness == 900.0


def test_cooldown():
    c = Cooldown(seconds=120)
    assert c.allows("g1", now=1000)
    c.mark("g1", now=1000)
    assert not c.allows("g1", now=1060)
    assert c.remaining("g1", now=1060) == 60
    assert c.allows("g1", now=1121)
    assert c.allows("g2", now=1060)


def test_specular_ratio_flags_glare():
    dark = np.full((40, 40), 80.0)
    glared = dark.copy()
    glared[:10, :10] = 255.0  # a bright patch, ~6% of the crop
    assert specular_ratio(dark) == 0.0
    assert specular_ratio(glared) > 0.05


def test_chroma_texture_needs_color():
    gray_only = np.zeros((30, 30))
    assert chroma_texture_score(gray_only) == 0.0  # wrong shape, not a crash

    RNG2 = np.random.default_rng(3)
    natural = RNG2.integers(60, 200, size=(30, 30, 3)).astype(np.float32)
    flat = np.full((30, 30, 3), 128.0)  # a uniform screen replay
    assert chroma_texture_score(flat) < chroma_texture_score(natural)


def test_check_liveness_rejects_blurry_flat_and_glared():
    RNG3 = np.random.default_rng(11)
    natural = RNG3.integers(40, 210, size=(50, 50, 3)).astype(np.float32)
    assert check_liveness(natural).passed

    blurry = np.full((50, 50, 3), 100.0)  # zero variance -> zero sharpness
    result = check_liveness(blurry)
    assert not result.passed
    assert result.reason == "too_blurry"

    # sharp edges but flat, uniform chroma — a screen replay
    checkerboard = np.zeros((50, 50, 3), dtype=np.float32)
    checkerboard[::2, ::2] = 200.0
    checkerboard[1::2, 1::2] = 200.0
    result = check_liveness(checkerboard, chroma_low=1000.0, chroma_high=2000.0)
    assert not result.passed
    assert result.reason == "flat_chroma"

    glared = natural.copy()
    glared[:25, :] = 255.0  # half the crop blown out
    result = check_liveness(glared)
    assert not result.passed
    assert result.reason == "glare"


# --------------------------------------------------------------------------
# Motion gate and overlay
#
# These use their own generators rather than the module-level RNG. Tests run
# in name order, so drawing from the shared RNG here would shift every random
# draw in the tests that sort after this point and break them.
# --------------------------------------------------------------------------

GATE_RNG = np.random.default_rng(101)
VIEW_RNG = np.random.default_rng(202)


def still_frame(value=100.0, shape=(60, 80)):
    """A doorway with nobody in it, plus a little sensor noise."""
    return np.full(shape, value, dtype=np.float32) + GATE_RNG.normal(scale=1.0, size=shape)


def view_person(jitter=0.0, base=None):
    v = VIEW_RNG.normal(size=D).astype(np.float32) if base is None else base.copy()
    if jitter:
        v = v + VIEW_RNG.normal(scale=jitter, size=D).astype(np.float32)
    return l2_normalize(v)


def view_gallery(n=6):
    entries, bases = [], []
    for i in range(n):
        base = view_person()
        bases.append(base)
        photos = np.stack([view_person(jitter=0.045, base=base) for _ in range(4)])
        entries.append(GalleryEntry(f"v{i}", f"Guest {i}", str(200 + i), l2_normalize(photos)))
    return entries, bases


def test_motion_gate_skips_an_empty_doorway():
    gate = MotionGate(hold_frames=2, force_every=1000)
    assert gate.update(still_frame()) is True   # first frame always detects

    for _ in range(2):                          # burn off the hold window
        gate.update(still_frame())

    decisions = [gate.update(still_frame()) for _ in range(40)]
    assert not any(decisions), "a static frame should never reach the detector"
    assert gate.skip_ratio > 0.8


def test_motion_gate_wakes_on_someone_walking_in():
    gate = MotionGate(hold_frames=3, force_every=1000)
    for _ in range(8):
        gate.update(still_frame())              # settle into the skip state

    person = still_frame()
    person[10:50, 20:60] = 30.0                 # a dark shape fills the frame
    assert gate.update(person) is True

    # and it keeps looking for a few frames after the movement stops
    assert gate.update(person) is True


def test_motion_gate_forces_a_sweep_so_a_still_person_cannot_hide():
    gate = MotionGate(hold_frames=1, force_every=5)
    frame = still_frame()
    gate.update(frame)
    decisions = [gate.update(frame) for _ in range(20)]
    assert any(decisions), "forced sweeps must keep running on a frozen scene"
    assert 0.1 <= sum(decisions) / len(decisions) <= 0.45   # occasional, not every frame


def test_motion_gate_handles_a_resolution_change_midstream():
    gate = MotionGate()
    gate.update(still_frame(shape=(60, 80)))
    assert gate.update(still_frame(shape=(120, 160))) is True


def test_overlay_names_an_enrolled_guest_and_flags_a_stranger():
    gallery, bases = view_gallery(6)
    known = Observation(bbox=(10.0, 20.0, 110.0, 140.0), sharpness=90.0,
                        embedding=view_person(jitter=0.045, base=bases[2]))
    stranger = Observation(bbox=(200.0, 20.0, 300.0, 140.0), sharpness=90.0,
                           embedding=view_person())

    boxes = build_overlay([known, stranger], gallery, frame_w=640, frame_h=360)

    assert boxes[0]["known"] is True
    assert boxes[0]["name"] == "Guest 2"
    assert boxes[1]["known"] is False
    assert boxes[1]["name"] == "Not recognised"
    assert all(b["score"] is not None for b in boxes)


def test_overlay_coordinates_are_fractions_of_the_frame():
    gallery, _ = view_gallery(3)
    obs = Observation(bbox=(64.0, 36.0, 320.0, 216.0), sharpness=50.0,
                      embedding=view_person())
    box = build_overlay([obs], gallery, frame_w=640, frame_h=360)[0]

    assert abs(box["x"] - 0.1) < 1e-6
    assert abs(box["y"] - 0.1) < 1e-6
    assert abs(box["w"] - 0.4) < 1e-6
    assert abs(box["h"] - 0.5) < 1e-6


def test_overlay_clamps_a_face_hanging_off_the_edge():
    gallery, _ = view_gallery(3)
    obs = Observation(bbox=(-40.0, -30.0, 700.0, 400.0), sharpness=50.0,
                      embedding=view_person())
    box = build_overlay([obs], gallery, frame_w=640, frame_h=360)[0]

    assert box["x"] == 0.0 and box["y"] == 0.0
    assert 0.0 <= box["w"] <= 1.0 and 0.0 <= box["h"] <= 1.0


def test_overlay_survives_an_empty_gallery_and_a_zero_size_frame():
    obs = Observation(bbox=(0.0, 0.0, 10.0, 10.0), sharpness=1.0,
                      embedding=view_person())
    assert build_overlay([obs], [], frame_w=640, frame_h=360)[0]["known"] is False
    assert build_overlay([obs], [], frame_w=0, frame_h=0) == []

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
