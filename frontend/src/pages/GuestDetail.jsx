import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { clockTime, getGuest, timeAgo } from '../api';
import { Empty, ErrorState, Loading, StatusPill } from '../components/StatusBits';

/**
 * One guest's full in/out history.
 *
 * Adapted from K.A.V.A.C.H's CaseDetail.jsx: same header-plus-timeline
 * structure, with the evidence trail replaced by movements grouped by day.
 */
export default function GuestDetail() {
  const { id } = useParams();
  const [guest, setGuest] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    setLoading(true);
    return getGuest(id)
      .then(setGuest)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => {
    if (!guest) return [];
    const groups = new Map();
    for (const log of guest.logs) {
      const key = new Date(log.timestamp).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(log);
    }
    return [...groups.entries()];
  }, [guest]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-6">
      <Link to="/guests" className="inline-block text-sm text-slate-600 hover:underline">
        Back to guest list
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{guest.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Room {guest.room_no}
            {guest.phone && (
              <>
                {' · '}
                <a
                  href={`tel:${guest.phone}`}
                  className="inline-block px-2 py-1 rounded hover:bg-slate-100 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                >
                  {guest.phone}
                </a>
              </>
            )} · last seen {timeAgo(guest.last_seen)}
          </p>
        </div>
        <StatusPill status={guest.status} presumed={guest.presumed} />
      </header>

      {!guest.active && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          This guest has moved out. Their face data has been deleted; the history below is kept as
          the record of their stay.
        </p>
      )}

      {days.length === 0 ? (
        <Empty>No movements recorded yet.</Empty>
      ) : (
        <div className="space-y-5">
          {days.map(([day, logs]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-medium text-slate-700">{day}</h2>
              <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {logs.map((log) => (
                  <li key={log.id} className="flex items-baseline gap-3 px-4 py-2.5">
                    <time className="w-20 shrink-0 text-sm tabular-nums text-slate-600" dateTime={log.timestamp}>
                      {clockTime(log.timestamp)}
                    </time>
                    <span className="w-14 shrink-0 text-sm font-medium">
                      {log.direction === 'out' ? 'Out' : 'In'}
                    </span>
                    <span className="min-w-0 flex-1 text-xs text-slate-500">
                      {log.source === 'manual'
                        ? 'entered by hand'
                        : log.inferred
                          ? 'camera · direction assumed'
                          : 'camera'}
                      {log.confidence != null && ` · match ${log.confidence.toFixed(2)}`}
                      {log.flagged && (
                        <span className="ml-1 text-amber-700">· {log.note}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
