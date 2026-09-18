import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { getSummary } from '../api';

/**
 * Shell for the register: sidebar on desktop, bottom bar on a phone.
 *
 * Adapted from K.A.V.A.C.H's AppLayout — same structure, new nav and
 * branding. Swap the literal Tailwind colours below for the project's
 * existing tokens from index.css if you'd rather keep KAVACH's palette.
 */

/**
 * The phone bar carries only what gets done at the door, and stops at four —
 * past that the ones that matter get harder to hit. "Add a guest" is reached
 * from the guest list instead, and tuning is a sit-down job, so "Unknown
 * faces" stays on desktop.
 */
const NAV = [
  { to: '/', label: 'Register', end: true, phone: true },
  { to: '/camera', label: 'At the door', phone: true },
  { to: '/guests', label: 'Guest list', phone: true },
  { to: '/add', label: 'Add a guest', phone: false },
  { to: '/log', label: 'Log entry', phone: true },
  { to: '/unknown', label: 'Unknown faces', phone: false },
];

function navClass({ isActive }) {
  return [
    'block rounded-md px-3 py-2 text-sm transition-colors',
    isActive
      ? 'bg-slate-900 text-white font-medium'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  ].join(' ');
}

/** Green when the API answered recently, amber when it didn't. */
function ServiceHealth() {
  const [online, setOnline] = useState(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      getSummary()
        .then(() => alive && setOnline(true))
        .catch(() => alive && setOnline(false));
    check();
    const t = setInterval(check, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (online === null) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span
        className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-amber-500'}`}
        aria-hidden="true"
      />
      {online ? 'Register online' : 'Register unreachable — log entries by hand'}
    </div>
  );
}

export default function AppLayout({ children }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 md:flex">
      <aside className="border-b border-slate-200 bg-white md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="px-5 py-5">
          <p className="text-base font-semibold tracking-tight">Entry register</p>
          <p className="mt-0.5 text-xs text-slate-500">Sai Residency PG</p>
        </div>
        <nav className="hidden space-y-1 px-3 pb-4 md:block">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-5 pb-5 md:block">
          <ServiceHealth />
        </div>
      </aside>

      <main className="flex-1 px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-8">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>

      {/* phone nav — the manager checks this at the door, not at a desk */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-200 bg-white md:hidden">
        {NAV.filter((item) => item.phone).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex-1 py-3 text-center text-sm ${
                isActive ? 'font-medium text-slate-900' : 'text-slate-500'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
