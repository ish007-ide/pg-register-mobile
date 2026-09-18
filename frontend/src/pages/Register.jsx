import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clockTime, getLogs, getSummary, today } from '../api';
import { Empty, ErrorState, Loading, Metric } from '../components/StatusBits';

/**
 * The page that replaces the paper register: who is where right now, and
 * every movement recorded today, newest first.
 *
 * Adapted from K.A.V.A.C.H's Dashboard.jsx — same metric-cards-over-table
 * layout, with case records swapped for movements.
 */
export default function Register() {
  const [summary, setSummary] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    return Promise.all([getSummary(), getLogs({ date: today() })])
      .then(([s, l]) => {
        setSummary(s);
        setLogs(l);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // the door doesn't wait for a refresh
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <Loading label="Reading the register…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const dayStart = summary?.day_started ? new Date(summary.day_started) : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Today at the door</h1>
        <p className="mt-1 text-sm text-slate-600">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          {dayStart && ` · counting from ${clockTime(dayStart.toISOString())}`}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Guests" value={summary.total_guests} />
        <Metric label="In" value={summary.currently_in} />
        <Metric label="Out" value={summary.currently_out} />
        <Metric label="Movements" value={summary.movements_today} hint="recorded today" />
      </div>

      {summary.unconfirmed > 0 && (
        <p className="text-sm text-slate-600">
          {summary.unconfirmed} of {summary.total_guests} haven't been seen since the register rolled
          over at 4am, so they're counted as in until the camera says otherwise.
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-700">Movements</h2>
        {logs.length === 0 ? (
          <Empty>
            Nothing recorded yet today. Movements appear here within a few seconds of someone
            passing the entrance camera.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {logs.map((log) => (
              <li key={log.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={`h-8 w-1 shrink-0 rounded-full ${
                    log.direction === 'out' ? 'bg-amber-400' : 'bg-emerald-500'
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <Link to={`/guests/${log.guest_id}`} className="font-medium hover:underline">
                      {log.guest_name}
                    </Link>
                    <span className="text-slate-500"> · room {log.room_no}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Went {log.direction}
                    {log.source === 'manual' && ' · entered by hand'}
                    {log.inferred && log.source === 'camera' && ' · direction assumed'}
                    {log.confidence != null && ` · match ${log.confidence.toFixed(2)}`}
                  </p>
                  {log.flagged && (
                    <p className="mt-1 text-xs text-amber-700">{log.note}</p>
                  )}
                </div>
                <time className="shrink-0 text-sm tabular-nums text-slate-600" dateTime={log.timestamp}>
                  {clockTime(log.timestamp)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
