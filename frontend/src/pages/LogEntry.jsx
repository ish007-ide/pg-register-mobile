import { useCallback, useEffect, useState } from 'react';
import { getGuests, logMovement, timeAgo } from '../api';
import { ErrorState, Loading, StatusPill } from '../components/StatusBits';

/**
 * Manual override — the fallback when the camera is down, a guest isn't
 * enrolled yet, or the register got someone's direction wrong.
 *
 * Entries made here are marked source: "manual" so the history shows which
 * rows a person wrote and which the camera did.
 */
export default function LogEntry() {
  const [guests, setGuests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    return getGuests()
      .then((rows) => setGuests(rows.filter((g) => g.active)))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(direction) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await logMovement({ guestId: selected.id, direction, note: note.trim() });
      setDone(`${selected.name} marked ${direction}.`);
      setSelected(null);
      setNote('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Log entry by hand</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a guest, then record which way they went. Use this when the camera is down or the
          register has someone on the wrong side of the door.
        </p>
      </header>

      {done && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {done}
        </p>
      )}
      {error && <ErrorState message={error} onRetry={load} />}

      <ul className="max-h-80 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {guests.map((guest) => (
          <li key={guest.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(guest);
                setDone(null);
              }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 min-h-[44px] ${
                selected?.id === guest.id ? 'bg-slate-100' : ''
              }`}
            >
              <span className="w-12 shrink-0 text-sm tabular-nums text-slate-500">{guest.room_no}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{guest.name}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Last seen {timeAgo(guest.last_seen)}
                </span>
              </span>
              <StatusPill status={guest.status} presumed={guest.presumed} />
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm">
            Recording a movement for <span className="font-medium">{selected.name}</span>, room{' '}
            {selected.room_no}. The register currently has them {selected.status}.
          </p>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason (optional) — e.g. camera offline"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 min-h-[44px]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => submit('in')}
              className="flex-1 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 min-h-[44px] min-w-[44px]"
            >
              Mark in
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => submit('out')}
              className="flex-1 rounded-md bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 min-h-[44px] min-w-[44px]"
            >
              Mark out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
