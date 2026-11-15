import type { ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import { FOCUS_RING, MONO } from './ui';

/** Resolving these needs an explicit confirm: severity ≥ 7, getting worse, or signal lost. */
export function resolveNeedsConfirm(i: Pick<Incident, 'severityScore' | 'trend' | 'escalated'>): boolean {
  return i.severityScore >= 7 || i.trend === 'worsening' || Boolean(i.escalated);
}

/** Reopening a silent live session gets it escalated by the API (signal lost, severity 10). */
export const REOPEN_STALE_MS = 60_000;

/**
 * Minutes since the last phone update when reopening would trigger that escalation: a live
 * session (sessionId) last seen more than 60 s ago. Null when it can reopen without asking.
 */
export function staleReopenMinutes(i: Pick<Incident, 'sessionId' | 'lastSeenAt'>, now: number): number | null {
  if (!i.sessionId || !i.lastSeenAt) return null;
  const age = now - Date.parse(i.lastSeenAt);
  if (!Number.isFinite(age) || age <= REOPEN_STALE_MS) return null;
  return Math.max(1, Math.round(age / 60_000));
}

export type PendingConfirm = { kind: 'resolve' } | { kind: 'reopen'; minutes: number };

export type StatusActionHandlers = {
  onAcknowledge: () => void;
  onUnacknowledge: () => void;
  onResolve: () => void;
  onReopen: () => void;
  /** Confirmation open for this incident, if any. */
  confirming: PendingConfirm | null;
  onConfirm: () => void;
  onCancelConfirm: () => void;
};

/** Status buttons for the detail panel and the full-screen card. */
export function StatusActions({ incident, compact = false, ...h }: StatusActionHandlers & { incident: Incident; compact?: boolean }) {
  if (h.confirming) {
    const why = [incident.escalated && 'signal lost', incident.trend === 'worsening' && 'worsening'].filter(Boolean).join(' · ');
    const minutes = h.confirming.kind === 'reopen' ? h.confirming.minutes : null;
    return (
      <div className="space-y-2" role="alertdialog" aria-label={minutes !== null ? 'Confirm reopen' : 'Confirm resolve'}>
        {minutes !== null ? (
          <p className="text-neutral-100">
            {`Last update was ${minutes} minute${minutes === 1 ? '' : 's'} ago. Reopening will mark this incident as signal lost at severity 10.`}
          </p>
        ) : (
          <p className="text-neutral-100">
            Resolve a severity {incident.severityScore} incident?
            {why && <span className={`ml-2 ${MONO} text-[11px] text-neutral-400`}>{why}</span>}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={h.onConfirm} shortcut="Enter" compact={compact}>
            Confirm
          </ActionButton>
          <ActionButton onClick={h.onCancelConfirm} shortcut="Esc" compact={compact}>
            Cancel
          </ActionButton>
        </div>
      </div>
    );
  }

  if (incident.status === 'RESOLVED') {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-neutral-400">Updates from the phone are paused while resolved.</p>
        <ActionButton onClick={h.onReopen} shortcut="O" compact={compact}>
          Reopen
        </ActionButton>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {incident.status === 'ACKNOWLEDGED' ? (
        <ActionButton onClick={h.onUnacknowledge} shortcut="U" compact={compact}>
          Unacknowledge
        </ActionButton>
      ) : (
        <ActionButton onClick={h.onAcknowledge} shortcut="A" compact={compact}>
          Acknowledge
        </ActionButton>
      )}
      <ActionButton onClick={h.onResolve} shortcut="R" compact={compact}>
        Resolve
      </ActionButton>
    </div>
  );
}

export function ActionButton({
  onClick,
  shortcut,
  compact = false,
  children,
}: {
  onClick: () => void;
  shortcut: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-keyshortcuts={shortcut}
      className={`flex w-full items-center justify-between rounded-[2px] border border-neutral-700 bg-neutral-900 px-3 text-neutral-100 hover:bg-neutral-800 ${
        compact ? 'h-7 text-[12px]' : 'h-8'
      } ${FOCUS_RING}`}
    >
      <span>{children}</span>
      <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] text-neutral-500`}>{shortcut}</kbd>
    </button>
  );
}
