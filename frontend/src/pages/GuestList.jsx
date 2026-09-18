import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGuests, timeAgo } from '../api';
import { Empty, ErrorState, Loading, StatusPill } from '../components/StatusBits';

/** All enrolled guests, their current state and when they were last seen. */
export default function GuestList() {
  const [guests, setGuests] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    return getGuests()
      .then(setGuests)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guests
      .filter((g) => g.active)
      .filter((g) => filter === 'all' || g.status === filter)
      .filter((g) => !q || g.name.toLowerCase().includes(q) || g.room_no.includes(q));
  }, [guests, filter, query]);

  if (loading) return <Loading label="Loading guests…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const counts = {
    all: guests.filter((g) => g.active).length,
    in: guests.filter((g) => g.active && g.status === 'in').length,
    out: guests.filter((g) => g.active && g.status === 'out').length,
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Guest list</h1>
          <p className="mt-1 text-sm text-slate-600">
            {counts.all} enrolled · tap a name for their full history
          </p>
        </div>
        <Link
          to="/add"
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 min-h-[44px] min-w-[44px]"
        >
          Add a guest
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {['all', 'in', 'out'].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1.5 text-sm min-h-[44px] min-w-[44px] ${
              filter === key
                ? 'bg-slate-900 text-white'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            {key === 'all' ? 'Everyone' : key === 'in' ? 'In' : 'Out'} ({counts[key]})
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or room"
          className="ml-auto w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 min-h-[44px]"
        />
      </div>

      {visible.length === 0 ? (
        <Empty>
          {guests.length === 0
            ? 'No one is enrolled yet. Run recognition/enroll.py with a guest\u2019s reference photos to add them.'
            : 'No guests match that filter.'}
        </Empty>
      ) : (
        <div className="space-y-3">
          {visible.map((guest) => (
            <Link
              key={guest.id}
              to={`/guests/${guest.id}`}
              className="block rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg font-semibold truncate">{guest.name}</span>
                    <StatusPill status={guest.status} presumed={guest.presumed} />
                  </div>
                  <p className="text-sm text-slate-600 mb-1">Room {guest.room_no}</p>
                  <p className="text-xs text-slate-500">
                    Last seen {timeAgo(guest.last_seen)}
                    {guest.movements_today > 0 && ` · ${guest.movements_today} today`}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
