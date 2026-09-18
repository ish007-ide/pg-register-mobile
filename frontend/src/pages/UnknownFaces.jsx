import { useCallback, useEffect, useMemo, useState } from 'react';
import { clockTime, getUnknownFaces } from '../api';
import { Empty, ErrorState, Loading } from '../components/StatusBits';

/**
 * Faces the matcher rejected — the page the README's tuning week runs on.
 *
 * These rows are deliberately kept out of the register. What they're good for
 * is reading the shape of the rejections: a pile of near-misses sitting just
 * under the threshold means real guests are being turned away, not that
 * strangers are streaming through the door.
 */

const DEFAULT_THRESHOLD = Number(import.meta.env.VITE_MATCH_THRESHOLD || 0.42);
const NEAR_MISS_BAND = 0.08; // "just under" — worth re-enrolling over

const REASON_LABEL = {
  below_threshold: 'Score too low',
  ambiguous: 'Two guests scored too close',
  empty_gallery: 'Nobody enrolled yet',
};

export default function UnknownFaces() {
  const [rows, setRows] = useState([]);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError(null);
    return getUnknownFaces(200)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const stats = useMemo(() => {
    const scored = rows.filter((r) => typeof r.best_score === 'number');
    return {
      total: rows.length,
      nearMisses: scored.filter(
        (r) => r.best_score < threshold && r.best_score >= threshold - NEAR_MISS_BAND
      ).length,
      ambiguous: rows.filter((r) => r.reason === 'ambiguous').length,
    };
  }, [rows, threshold]);

  if (loading) return <Loading label="Reading rejected faces…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Unknown faces</h1>
        <p className="mt-1 text-sm text-slate-600">
          Faces the matcher saw but wouldn&rsquo;t put a name to. Run for a week with{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">LOG_UNKNOWNS=1</code> before
          changing any thresholds.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        <label htmlFor="threshold" className="text-slate-600">
          Comparing against MATCH_THRESHOLD
        </label>
        <input
          id="threshold"
          type="number"
          step="0.01"
          min="0"
          max="1"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 min-h-[44px]"
        />
        <span className="text-xs text-slate-500">
          set this to whatever the recognition service is actually running
        </span>
      </div>

      {stats.total > 0 && (
        <p className="text-sm text-slate-600">
          {stats.total} rejected in the last run of the log. {stats.nearMisses} scored within{' '}
          {NEAR_MISS_BAND.toFixed(2)} of the threshold — if those are your own guests, re-enroll
          them with better photos before you lower it. {stats.ambiguous} were rejected for being
          too close to a second guest, which the margin is meant to catch.
        </p>
      )}

      {rows.length === 0 ? (
        <Empty>
          Nothing rejected yet. Either everyone walking past is enrolled and matching cleanly, or
          the recognition service is running with LOG_UNKNOWNS off.
        </Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const near =
              typeof row.best_score === 'number' &&
              row.best_score < threshold &&
              row.best_score >= threshold - NEAR_MISS_BAND;
            return (
              <div
                key={row.id}
                className="rounded-lg border border-slate-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium mb-1">
                      {REASON_LABEL[row.reason] || row.reason}
                      {near && <span className="ml-2 text-xs text-amber-700">near miss</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {row.direction ? `Walking ${row.direction}` : 'Direction unclear'}
                    </p>
                  </div>
                  <span className="text-sm tabular-nums text-slate-700 font-semibold">
                    {typeof row.best_score === 'number' ? row.best_score.toFixed(3) : '—'}
                  </span>
                </div>
                <time className="text-xs text-slate-500" dateTime={row.timestamp}>
                  {clockTime(row.timestamp)}
                </time>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
