import { severityTier, type Incident } from '@/types/incident';
import { TIERS, TIER_STYLES } from './severity';
import { LABEL, MONO } from './ui';
import type { FeedSync } from './useIncidentFeed';

type Props = {
  incidents: Incident[];
  now: number | null;
  sync: FeedSync;
};

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function SyncStatus({ sync, now }: { sync: FeedSync; now: number | null }) {
  const age = (t: number | null) => (now === null || t === null ? '–' : `${Math.max(0, Math.floor((now - t) / 1000))}s`);
  switch (sync.state) {
    case 'mock':
      return (
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" aria-hidden />
          <span className="text-neutral-200">MOCK DATA</span>
        </span>
      );
    case 'live':
      return (
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400 motion-safe:animate-pulse" aria-hidden />
          <span className="text-neutral-100">LIVE</span>
          <span className="text-neutral-500">last sync {age(sync.lastSync)} ago</span>
        </span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-2" role="alert" title={sync.message}>
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
          <span className="text-red-300">SYNC FAILED</span>
          <span className="text-neutral-400">
            {sync.lastSync === null ? 'no data yet' : `showing data from ${age(sync.lastSync)} ago`}
          </span>
        </span>
      );
    default:
      return <span className="text-neutral-500">CONNECTING…</span>;
  }
}

export function TopBar({ incidents, now, sync }: Props) {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<(typeof TIERS)[number], number>;
  for (const i of incidents) if (i.status === 'ACTIVE') counts[severityTier(i.severityScore)]++;
  const d = now === null ? null : new Date(now);

  return (
    <header className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-neutral-800 px-3">
      <div className="flex items-baseline gap-3">
        <span className="text-[13px] font-semibold tracking-[0.08em] text-neutral-100">SILENTPULSE · DISPATCH</span>
        <span className={LABEL}>UMass Amherst Pilot</span>
      </div>

      <div className={`${MONO} text-[12px]`} aria-label="Open incidents by severity">
        <span className="mr-3 text-neutral-500">OPEN</span>
        {TIERS.map((tier, idx) => (
          <span key={tier}>
            {idx > 0 && <span className="px-2 text-neutral-700">·</span>}
            <span className={counts[tier] ? 'text-neutral-100' : 'text-neutral-600'}>
              {TIER_STYLES[tier].label.toUpperCase()} {counts[tier]}
            </span>
          </span>
        ))}
      </div>

      <div className={`flex items-center justify-end gap-4 ${MONO} text-[12px]`}>
        <SyncStatus sync={sync} now={now} />
        <span className="text-neutral-500">
          {d ? `${DAYS[d.getDay()]} ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '--- -- --- ----'}
        </span>
        <time className="w-[8ch] text-right text-[13px] text-neutral-100">
          {d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '--:--:--'}
        </time>
      </div>
    </header>
  );
}
