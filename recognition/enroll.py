#!/usr/bin/env python3
"""Enroll a guest into the PG register.

    python3 enroll.py --name "Asha Kulkarni" --room 204 \
        --photos photos/asha/*.jpg --consent-given

Writes two files, deliberately kept apart:

  data/guests.json      roster — id, name, room, consent, enrolled_at.
                        Served to the browser.
  data/embeddings.json  face embeddings. Never leaves the mini PC; the
                        Express API does not read or serve this file.

Every reference photo is stored as its own embedding rather than averaged.
See recognition/core.py:identify for why.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from core import l2_normalize, sharpness

DATA = Path(__file__).resolve().parents[1] / "data"
GUESTS = DATA / "guests.json"
EMBEDDINGS = DATA / "embeddings.json"

# Set by --json. The backend spawns this script when the warden adds a guest
# from the browser, and needs a parseable result rather than prose. Progress
# goes to stderr in that mode so stdout stays a single JSON object.
JSON_MODE = False


def note(message: str) -> None:
    """Progress chatter. Never contaminates stdout in --json mode."""
    print(message, file=sys.stderr if JSON_MODE else sys.stdout)


def die(message: str, code: str = "error") -> None:
    """Stop with a message the warden can act on."""
    if JSON_MODE:
        print(json.dumps({"ok": False, "code": code, "error": message}))
        raise SystemExit(1)
    sys.exit(message)


MIN_FACE_PX = 110          # reference faces should be well over the live minimum
MIN_SHARPNESS = 40.0       # variance-of-Laplacian floor
OUTLIER_SIMILARITY = 0.35  # flag a photo that doesn't look like the others


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic, so a crash mid-write can't truncate the roster


def build_model(det_size: int = 640):
    """Load InsightFace. Imported lazily so --list and --remove work without it."""
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        die(
            "The face recognition software isn't installed on this machine yet.\n"
            "  pip install insightface onnxruntime opencv-python-headless\n"
            "First run downloads the model pack (~300MB) to ~/.insightface.",
            code="model_missing",
        )
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(det_size, det_size))
    return app


def embed_photo(app, path: Path) -> np.ndarray:
    """Return the L2-normalised embedding of the single face in `path`."""
    import cv2

    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"could not read {path}")

    faces = app.get(img)
    if not faces:
        raise ValueError(f"no face found in {path.name}")
    if len(faces) > 1:
        raise ValueError(
            f"{len(faces)} faces in {path.name} — use a photo of the guest alone"
        )

    face = faces[0]
    x1, y1, x2, y2 = (int(v) for v in face.bbox)
    w, h = x2 - x1, y2 - y1
    if min(w, h) < MIN_FACE_PX:
        raise ValueError(f"face in {path.name} is only {min(w, h)}px — move closer")

    crop = img[max(0, y1) : y2, max(0, x1) : x2]
    s = sharpness(crop)
    if s < MIN_SHARPNESS:
        raise ValueError(f"{path.name} is too blurry (sharpness {s:.0f})")

    return l2_normalize(face.normed_embedding.astype(np.float32))


def check_consistency(vectors: list[np.ndarray], names: list[str]) -> None:
    """Warn if one photo looks like a different person from the rest."""
    if len(vectors) < 3:
        return
    stack = np.stack(vectors)
    sims = stack @ stack.T
    for i, name in enumerate(names):
        others = np.delete(sims[i], i)
        if float(np.mean(others)) < OUTLIER_SIMILARITY:
            print(
                f"  warning: {name} looks unlike the other photos "
                f"(mean similarity {np.mean(others):.2f}). Wrong person, or a "
                f"very different angle? It is stored, but check it.",
                file=sys.stderr,
            )


def check_against_existing(vector: np.ndarray, embeddings: list[dict], guests: list[dict]) -> None:
    """Refuse to enroll someone who is already in the register under another name."""
    by_id = {g["id"]: g for g in guests}
    for rec in embeddings:
        stored = l2_normalize(np.asarray(rec["embeddings"], dtype=np.float32))
        best = float(np.max(stored @ vector))
        if best > 0.55:
            existing = by_id.get(rec["id"], {}).get("name", rec["id"])
            die(
                f"These photos look like someone already on the list: {existing}. "
                f"Check whether this guest has been added before under another name.",
                code="duplicate_person",
            )


def cmd_enroll(args) -> int:
    paths = [Path(p) for p in args.photos]
    missing = [p for p in paths if not p.exists()]
    if missing:
        die("Some photos could not be read: " + ", ".join(m.name for m in missing),
            code="missing_files")
    if not 3 <= len(paths) <= 8:
        die(f"Please choose between 3 and 8 photos. You chose {len(paths)}.",
            code="photo_count")
    if not args.consent_given:
        die(
            "The guest's written consent has to be on file before they can be added. "
            "A face embedding is biometric data under the DPDP Act; it can be deleted "
            "again at any time on request.",
            code="consent_required",
        )

    guests = load_json(GUESTS, [])
    embeddings = load_json(EMBEDDINGS, [])
    if any(g["room_no"] == str(args.room) and g["name"] == args.name for g in guests):
        die(f"{args.name} in room {args.room} is already on the list.",
            code="already_enrolled")

    note(f"Loading model, then reading {len(paths)} photos…")
    app = build_model(args.det_size)

    vectors, used, skipped = [], [], []
    for p in paths:
        try:
            vectors.append(embed_photo(app, p))
            used.append(p.name)
            note(f"  ok    {p.name}")
        except ValueError as e:
            skipped.append(str(e))
            note(f"  skip  {e}")

    if len(vectors) < 3:
        detail = " ".join(skipped)
        die(
            f"Only {len(vectors)} of the {len(paths)} photos were usable, and at least 3 "
            f"are needed. {detail}".strip(),
            code="not_enough_usable",
        )

    check_consistency(vectors, used)
    check_against_existing(np.mean(np.stack(vectors), axis=0), embeddings, guests)

    guest_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()

    guests.append(
        {
            "id": guest_id,
            "name": args.name,
            "room_no": str(args.room),
            "phone": args.phone or "",
            "active": True,
            "consent_recorded": True,
            "enrolled_at": now,
            "photo_count": len(vectors),
        }
    )
    embeddings.append(
        {
            "id": guest_id,
            "name": args.name,
            "room_no": str(args.room),
            "embeddings": [v.tolist() for v in vectors],
            "source_photos": used,
            "enrolled_at": now,
        }
    )

    save_json(GUESTS, guests)
    save_json(EMBEDDINGS, embeddings)

    if JSON_MODE:
        print(json.dumps({
            "ok": True,
            "id": guest_id,
            "name": args.name,
            "room_no": str(args.room),
            "photo_count": len(vectors),
            "skipped": skipped,
        }))
    else:
        print(f"\nEnrolled {args.name} (room {args.room}) from {len(vectors)} photos.")
        print(f"id {guest_id} — the camera picks this up within a few seconds.")
    return 0


def cmd_list(_args) -> int:
    guests = load_json(GUESTS, [])
    if not guests:
        print("No guests enrolled yet.")
        return 0
    width = max(len(g["name"]) for g in guests)
    for g in sorted(guests, key=lambda g: (g["room_no"], g["name"])):
        flag = "" if g.get("active", True) else "  (moved out)"
        print(f"  {g['room_no']:>5}  {g['name']:<{width}}  {g['id']}{flag}")
    print(f"\n{len(guests)} enrolled.")
    return 0


def cmd_remove(args) -> int:
    """Delete a guest's biometrics. Their visit history stays in the register."""
    guests = load_json(GUESTS, [])
    embeddings = load_json(EMBEDDINGS, [])
    target = [g for g in guests if args.remove in (g["id"], g["name"])]
    if not target:
        die(f"No guest matching {args.remove!r}.", code="not_found")
    if len(target) > 1:
        die("That name matches more than one guest — use the id instead.",
            code="ambiguous")

    guest = target[0]
    if args.keep_record:
        guest["active"] = False
        guest["photo_count"] = 0
        guest["biometrics_deleted_at"] = datetime.now(timezone.utc).isoformat()
    else:
        guests = [g for g in guests if g["id"] != guest["id"]]

    save_json(GUESTS, guests)
    save_json(EMBEDDINGS, [e for e in embeddings if e["id"] != guest["id"]])
    if JSON_MODE:
        print(json.dumps({"ok": True, "id": guest["id"], "name": guest["name"],
                          "removed": True}))
    else:
        print(f"Deleted face data for {guest['name']} (room {guest['room_no']}).")
        print("The camera stops matching them within a few seconds.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name")
    p.add_argument("--room")
    p.add_argument("--phone")
    p.add_argument("--photos", nargs="*", default=[], help="3–8 reference photos")
    p.add_argument("--consent-given", action="store_true", help="written consent is on file")
    p.add_argument("--det-size", type=int, default=640)
    p.add_argument("--json", action="store_true", help="machine-readable result on stdout (used by the dashboard)")
    p.add_argument("--list", action="store_true", help="show enrolled guests")
    p.add_argument("--remove", metavar="ID_OR_NAME", help="delete a guest's face data")
    p.add_argument("--keep-record", action="store_true", help="with --remove: keep the roster row, drop only the biometrics")
    args = p.parse_args()

    global JSON_MODE
    JSON_MODE = args.json

    if args.list:
        return cmd_list(args)
    if args.remove:
        return cmd_remove(args)
    if not (args.name and args.room and args.photos):
        if JSON_MODE:
            die("Name, room and photos are all required.", code="missing_fields")
        p.error("--name, --room and --photos are required to enroll")
    return cmd_enroll(args)


if __name__ == "__main__":
    raise SystemExit(main())
