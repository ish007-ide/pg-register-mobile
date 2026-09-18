import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getEnrollment, startEnrollment } from '../api';

/**
 * Adding a guest, for someone who has never heard the word "enrollment".
 *
 * The page is three plain questions — who, what do they look like, have they
 * agreed — and one button. Everything technical is either done quietly or
 * explained in the same words a person would use out loud.
 *
 * Photos are shrunk in the browser before they're sent. A phone photo is
 * several megabytes and 4000px wide; the recogniser wants a face over 110px,
 * which 1600px gives it many times over. Sending the originals over PG wifi
 * to a mini PC would be slow for no gain.
 */

const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.9;
const POLL_MS = 1500;

const HEIC = /\.(heic|heif)$/i;

async function decode(file) {
  // createImageBitmap honours the rotation flag phones write into photos.
  // Without it, a portrait shot arrives on its side and the face is missed.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the img path below */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not read'));
    };
    img.src = url;
  });
}

/** File -> { filename, data } with the long edge capped. */
async function shrink(file) {
  const source = await decode(file);
  const w = source.width;
  const h = source.height;
  if (!w || !h) throw new Error('could not read');

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === 'function') source.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    filename: file.name || 'photo.jpg',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    preview: dataUrl,
  };
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-800">{label}</span>
      {hint && <span className="ml-2 text-xs text-slate-500">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base '
  + 'placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 '
  + 'focus:ring-slate-500 min-h-[44px]';

export default function AddGuest() {
  const [name, setName] = useState('');
  const [roomNo, setRoomNo] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [photos, setPhotos] = useState([]);

  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState(null);
  const [job, setJob] = useState(null);
  const [done, setDone] = useState(null);

  const fileRef = useRef(null);
  const pollRef = useRef(null);

  const addFiles = useCallback(
    async (fileList) => {
      const chosen = Array.from(fileList || []);
      if (!chosen.length) return;
      setProblem(null);

      const iphone = chosen.find((f) => HEIC.test(f.name));
      if (iphone) {
        setProblem(
          `${iphone.name} is an iPhone HEIC photo, which this system can\u2019t read. `
          + 'On the iPhone: Settings \u203a Camera \u203a Formats \u203a Most Compatible, then take '
          + 'the photos again. Or send them to yourself on WhatsApp first, which turns '
          + 'them into ordinary photos.'
        );
        return;
      }

      const room = MAX_PHOTOS - photos.length;
      if (room <= 0) {
        setProblem(`That\u2019s already ${MAX_PHOTOS} photos, which is plenty.`);
        return;
      }

      setReading(true);
      try {
        const accepted = [];
        for (const file of chosen.slice(0, room)) {
          if (!/^image\//.test(file.type)) {
            setProblem(`${file.name} isn\u2019t a photo.`);
            continue;
          }
          try {
            accepted.push(await shrink(file));
          } catch {
            setProblem(`${file.name} couldn\u2019t be opened. Try a different photo.`);
          }
        }
        if (accepted.length) setPhotos((current) => [...current, ...accepted]);
        if (chosen.length > room) {
          setProblem(`Only the first ${room} were added \u2014 ${MAX_PHOTOS} is the most that helps.`);
        }
      } finally {
        setReading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [photos.length]
  );

  const removePhoto = (index) =>
    setPhotos((current) => current.filter((_, i) => i !== index));

  // --- the job ------------------------------------------------------------

  useEffect(() => () => clearInterval(pollRef.current), []);

  const submit = async (event) => {
    event.preventDefault();
    setProblem(null);

    try {
      const started = await startEnrollment({
        name: name.trim(),
        roomNo: roomNo.trim(),
        phone: phone.trim(),
        consent,
        photos: photos.map(({ filename, data }) => ({ filename, data })),
      });
      setJob(started);

      pollRef.current = setInterval(async () => {
        try {
          const latest = await getEnrollment(started.id);
          if (latest.status === 'running') {
            setJob(latest);
            return;
          }

          clearInterval(pollRef.current);
          setJob(null);
          if (latest.status === 'done') {
            setDone(latest.guest);
          } else {
            // Clearing the job is what takes the spinner down. Without it a
            // failed enrollment sits there turning forever.
            setProblem(latest.error || 'Adding the guest failed. Please try again.');
          }
        } catch (err) {
          clearInterval(pollRef.current);
          setJob(null);
          setProblem(err.message);
        }
      }, POLL_MS);
    } catch (err) {
      setProblem(err.message);
    }
  };

  const reset = () => {
    setName('');
    setRoomNo('');
    setPhone('');
    setConsent(false);
    setPhotos([]);
    setDone(null);
    setJob(null);
    setProblem(null);
  };

  // --- what's stopping us -------------------------------------------------

  const blocker = !name.trim()
    ? 'Enter the guest\u2019s name'
    : !roomNo.trim()
      ? 'Enter a room number'
      : photos.length < MIN_PHOTOS
        ? `Add ${MIN_PHOTOS - photos.length} more photo${MIN_PHOTOS - photos.length === 1 ? '' : 's'}`
        : !consent
          ? 'Tick the consent box'
          : null;

  // --- states -------------------------------------------------------------

  if (done) {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-6">
          <h1 className="text-lg font-semibold text-emerald-900">
            {done.name} has been added
          </h1>
          <p className="mt-2 text-sm text-emerald-800">
            Room {done.room_no}, learned from {done.photo_count} photos. The camera starts
            recognising them within a few seconds — nothing else to do.
          </p>
          <p className="mt-2 text-sm text-emerald-800">
            The photos have been deleted. Only the face measurements are kept, and those can
            be removed again whenever the guest asks.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 min-h-[44px] min-w-[44px]"
          >
            Add another guest
          </button>
          <Link
            to={`/guests/${done.id}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 min-h-[44px] min-w-[44px]"
          >
            See their page
          </Link>
        </div>
      </div>
    );
  }

  if (job && job.status === 'running') {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Adding {job.name}…</h1>
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-5 py-5">
          <span
            className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm text-slate-800">
              Learning {job.name}’s face from {job.photo_count} photos.
            </p>
            <p className="mt-1 text-sm text-slate-600">
              This takes up to a minute, and several minutes the very first time. You can
              leave this page open — it will say when it’s finished.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Add a guest</h1>
        <p className="mt-1 text-sm text-slate-600">
          Fill in who they are and add a few photos. The camera will recognise them from then on.
        </p>
      </header>

      {problem && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">{problem}</p>
        </div>
      )}

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white px-5 py-5">
        <h2 className="text-sm font-semibold text-slate-900">1. Who is it?</h2>

        <Field label="Full name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Asha Kulkarni"
            autoComplete="off"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Room number">
            <input
              className={inputClass}
              value={roomNo}
              onChange={(e) => setRoomNo(e.target.value)}
              placeholder="204"
              autoComplete="off"
            />
          </Field>
          <Field label="Phone" hint="optional">
            <input
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              autoComplete="off"
              inputMode="tel"
            />
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white px-5 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">2. Their photos</h2>
          <p className="text-sm text-slate-600">
            {photos.length} of {MIN_PHOTOS} needed
            {photos.length >= MIN_PHOTOS && ' \u2014 that\u2019s enough'}
          </p>
        </div>

        <p className="text-sm text-slate-600">
          Three to eight photos of their face, taken a little differently each time — looking
          straight on, slightly to the side, in different light. One person per photo, no
          sunglasses or mask. More angles means fewer mistakes at the door.
        </p>

        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {photos.map((photo, i) => (
              <li key={`${photo.filename}-${i}`} className="relative">
                <img
                  src={photo.preview}
                  alt={photo.filename}
                  className="aspect-square w-full rounded-lg object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove ${photo.filename}`}
                  className="absolute -right-2 -top-2 h-7 w-7 rounded-full border border-slate-300 bg-white text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-100"
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={reading || photos.length >= MAX_PHOTOS}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 min-h-[44px] min-w-[44px]"
          >
            {reading
              ? 'Opening photos\u2026'
              : photos.length
                ? 'Add more photos'
                : 'Choose photos'}
          </button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white px-5 py-5">
        <h2 className="text-sm font-semibold text-slate-900">3. Consent</h2>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300"
          />
          <span className="text-sm text-slate-700">
            This guest has agreed in writing to face recognition being used at the entrance.
            <span className="mt-1 block text-slate-500">
              Their face measurements stay on this machine and can be deleted whenever they
              ask. The photos are deleted as soon as the face has been learned.
            </span>
          </span>
        </label>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={Boolean(blocker) || reading}
          className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 min-h-[44px] min-w-[44px]"
        >
          Add this guest
        </button>
        {blocker && <p className="text-sm text-slate-500">{blocker} first.</p>}
      </div>
    </form>
  );
}
