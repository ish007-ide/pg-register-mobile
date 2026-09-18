/**
 * The small shared pieces every page leans on.
 *
 * Kept in one file because none of them is big enough to earn its own, and
 * keeping them together makes it obvious when two pages drift apart on what
 * "out" should look like.
 */

/** Shown while the first fetch is in flight. Polling refreshes don't use it. */
export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

/**
 * A failed fetch, with the reason and a way out. The register is the thing a
 * manager checks at the door, so a dead end here means falling back to paper.
 */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
      <p className="text-sm font-medium text-amber-900">Couldn&rsquo;t reach the register</p>
      <p className="mt-1 text-sm text-amber-800">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Nothing to show yet. The children say what would fill it. */
export function Empty({ children }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
      {children}
    </div>
  );
}

/**
 * Where a guest is right now.
 *
 * `presumed` means the register hasn't seen them since the 4am rollover, so
 * "in" is the default rather than an observation. Showing that difference
 * matters: a manager reading the board should know which rows the camera
 * actually put there.
 */
export function StatusPill({ status, presumed = false }) {
  const out = status === 'out';
  const tone = presumed
    ? 'border-slate-200 bg-slate-100 text-slate-600'
    : out
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';

  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
      title={presumed ? 'Not seen since the register rolled over at 4am' : undefined}
    >
      {out ? 'Out' : 'In'}
      {presumed && ' (assumed)'}
    </span>
  );
}

/** One number on the register header. */
export function Metric({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value ?? '—'}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
