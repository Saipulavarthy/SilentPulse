'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { severityTier, type Incident } from '@/types/incident';
import { TIERS, TIER_STYLES } from './severity';
import { ActionButton } from './StatusActions';
import { FOCUS_RING, LABEL, MONO } from './ui';
import type { FeedSync } from './useIncidentFeed';

type Props = {
  incidents: Incident[];
  now: number | null;
  sync: FeedSync;
  /** Deletes every incident (open and acknowledged included). */
  onResetDemo: () => void;
};

const RESET_WORD = 'DELETE';
/** The right-hand cluster is mono; the menu reads as prose. */
const SANS = 'font-[family-name:var(--font-plex-sans)]';

/**
 * Overflow menu with "Reset demo". The only bulk delete that reaches open and acknowledged
 * incidents, so it needs DELETE typed before the confirm button enables.
 */
function OverflowMenu({ total, onResetDemo }: { total: number; onResetDemo: () => void }) {
  const [step, setStep] = useState<'closed' | 'menu' | 'confirm'>('closed');
  const [typed, setTyped] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const close = () => {
    setStep('closed');
    setTyped('');
  };

  // Click outside closes.
  useEffect(() => {
    if (step === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setStep('closed');
        setTyped('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [step]);

  const armed = typed === RESET_WORD;
  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!armed) return;
    close();
    onResetDemo();
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        // Esc closes the menu only (stopPropagation keeps the page from also leaving full screen).
        if (e.key === 'Escape' && step !== 'closed') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={step !== 'closed'}
        onClick={() => (step === 'closed' ? setStep('menu') : close())}
        className={`h-6 rounded-[2px] border border-neutral-700 px-1.5 leading-none text-neutral-300 hover:bg-neutral-800 ${FOCUS_RING}`}
      >
        ···
      </button>
      {step === 'menu' && (
        <div role="menu" className={`absolute top-8 right-0 z-50 w-[260px] rounded-[2px] border border-neutral-700 bg-neutral-950 py-1 ${SANS}`}>
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => setStep('confirm')}
            className={`block w-full px-3 py-1.5 text-left text-[12px] text-red-200 hover:bg-red-950/60 ${FOCUS_RING}`}
          >
            Reset demo: delete ALL incidents
          </button>
        </div>
      )}
      {step === 'confirm' && (
        <form
          onSubmit={submit}
          role="alertdialog"
          aria-label="Confirm reset demo"
          className={`absolute top-8 right-0 z-50 w-[320px] space-y-2 rounded-[2px] border border-red-900 bg-neutral-950 p-3 ${SANS} text-[13px]`}
        >
          <p className="text-neutral-100">
            Permanently delete every incident, including open and acknowledged ones ({total} on screen). This cannot be undone.
            Medical profiles are kept.
          </p>
          <label className="block text-[12px] text-neutral-400">
            Type <span className={`${MONO} text-neutral-100`}>{RESET_WORD}</span> to confirm
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Type ${RESET_WORD} to confirm`}
              className={`mt-1 block h-7 w-full rounded-[2px] border border-neutral-700 bg-neutral-900 px-2 ${MONO} text-[12px] text-neutral-100 ${FOCUS_RING}`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton onClick={() => submit()} shortcut="Enter" compact tone="danger" disabled={!armed}>
              Delete all
            </ActionButton>
            <ActionButton onClick={close} shortcut="Esc" compact>
              Cancel
            </ActionButton>
          </div>
        </form>
      )}
    </div>
  );
}

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

export function TopBar({ incidents, now, sync, onResetDemo }: Props) {
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
        <OverflowMenu total={incidents.length} onResetDemo={onResetDemo} />
      </div>
    </header>
  );
}
