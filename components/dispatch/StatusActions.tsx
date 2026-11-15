import type { ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import { incidentNumber } from './severity';
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

/**
 * The caller's phone session updated within the last 60 s, so it is probably still sending:
 * its next update would create the incident again.
 */
export function phoneStillSending(i: Pick<Incident, 'sessionId' | 'lastSeenAt'>, now: number): boolean {
  if (!i.sessionId || !i.lastSeenAt) return false;
  const age = now - Date.parse(i.lastSeenAt);
  return Number.isFinite(age) && age <= REOPEN_STALE_MS;
}

export type PendingConfirm =
  | { kind: 'resolve' }
  | { kind: 'reopen'; minutes: number }
  | { kind: 'delete'; stillSending: boolean };

export type StatusActionHandlers = {
  onAcknowledge: () => void;
  onUnacknowledge: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  /** Confirmation open for this incident, if any. */
  confirming: PendingConfirm | null;
  onConfirm: () => void;
  onCancelConfirm: () => void;
};

/** Status buttons for the detail panel and the full-screen card, with Delete set apart below. */
export function StatusActions({ incident, compact = false, ...h }: StatusActionHandlers & { incident: Incident; compact?: boolean }) {
  if (h.confirming) {
    return (
      <ConfirmPrompt
        incident={incident}
        confirming={h.confirming}
        compact={compact}
        onConfirm={h.onConfirm}
        onCancelConfirm={h.onCancelConfirm}
      />
    );
  }

  return (
    <div>
      {incident.status === 'RESOLVED' ? (
        <div className="space-y-2">
          <p className="text-[12px] text-neutral-400">Updates from the phone are paused while resolved.</p>
          <ActionButton onClick={h.onReopen} shortcut="O" compact={compact}>
            Reopen
          </ActionButton>
        </div>
      ) : (
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
      )}
      <div className={`border-t border-neutral-800 ${compact ? 'mt-2 pt-2' : 'mt-3 pt-3'}`}>
        <ActionButton onClick={h.onDelete} shortcut="Shift+D" compact={compact} tone="danger">
          Delete
        </ActionButton>
      </div>
    </div>
  );
}

function ConfirmPrompt({
  incident,
  confirming,
  compact,
  onConfirm,
  onCancelConfirm,
}: {
  incident: Incident;
  confirming: PendingConfirm;
  compact: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}) {
  const label = confirming.kind === 'delete' ? 'Confirm delete' : confirming.kind === 'reopen' ? 'Confirm reopen' : 'Confirm resolve';
  let message: ReactNode;
  if (confirming.kind === 'delete') {
    message = (
      <>
        <p className="text-neutral-100">{`Permanently delete ${incidentNumber(incident._id)}? This cannot be undone.`}</p>
        {confirming.stillSending && (
          <p className="text-[12px] text-amber-200">
            The caller&apos;s phone is still sending updates; this incident will reappear on the next update.
          </p>
        )}
      </>
    );
  } else if (confirming.kind === 'reopen') {
    const m = confirming.minutes;
    message = (
      <p className="text-neutral-100">
        {`Last update was ${m} minute${m === 1 ? '' : 's'} ago. Reopening will mark this incident as signal lost at severity 10.`}
      </p>
    );
  } else {
    const why = [incident.escalated && 'signal lost', incident.trend === 'worsening' && 'worsening'].filter(Boolean).join(' · ');
    message = (
      <p className="text-neutral-100">
        Resolve a severity {incident.severityScore} incident?
        {why && <span className={`ml-2 ${MONO} text-[11px] text-neutral-400`}>{why}</span>}
      </p>
    );
  }
  return (
    <div className="space-y-2" role="alertdialog" aria-label={label}>
      {message}
      <ConfirmButtons onConfirm={onConfirm} onCancel={onCancelConfirm} compact={compact} danger={confirming.kind === 'delete'} />
    </div>
  );
}

/** Confirm (Enter) / Cancel (Esc) pair, shared by every inline confirmation. */
export function ConfirmButtons({
  onConfirm,
  onCancel,
  compact = false,
  danger = false,
  confirmLabel = 'Confirm',
}: {
  onConfirm: () => void;
  onCancel: () => void;
  compact?: boolean;
  danger?: boolean;
  confirmLabel?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <ActionButton onClick={onConfirm} shortcut="Enter" compact={compact} tone={danger ? 'danger' : undefined}>
        {confirmLabel}
      </ActionButton>
      <ActionButton onClick={onCancel} shortcut="Esc" compact={compact}>
        Cancel
      </ActionButton>
    </div>
  );
}

export function ActionButton({
  onClick,
  shortcut,
  compact = false,
  tone,
  disabled = false,
  children,
}: {
  onClick: () => void;
  shortcut: string;
  compact?: boolean;
  /** danger: destructive (delete). */
  tone?: 'danger';
  disabled?: boolean;
  children: ReactNode;
}) {
  const colors =
    tone === 'danger'
      ? 'border-red-900 bg-red-950/40 text-red-200 hover:bg-red-950 enabled:hover:text-red-100'
      : 'border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-keyshortcuts={shortcut}
      className={`flex w-full items-center justify-between rounded-[2px] border px-3 disabled:cursor-not-allowed disabled:opacity-40 ${colors} ${
        compact ? 'h-7 text-[12px]' : 'h-8'
      } ${FOCUS_RING}`}
    >
      <span>{children}</span>
      <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] ${tone === 'danger' ? 'text-red-300/70' : 'text-neutral-500'}`}>
        {shortcut}
      </kbd>
    </button>
  );
}
