'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { CrisisType, Incident } from '@/types/incident';
import { FOCUS_RING, LABEL, MONO } from './ui';

const MAX_LEN = 140;

const PRESETS_ANY = ['We can see your location. Help is coming.'] as const;

const PRESETS_BY_TYPE: Record<CrisisType, readonly string[]> = {
  ACTIVE_THREAT: [
    'Police are on the way. Stay hidden and silent.',
    'Stay where you are. Do not open the door.',
    ...PRESETS_ANY,
  ],
  MEDICAL_CRISIS: [
    'Help is on the way. Stay with them.',
    'Keep doing CPR. EMS is 2 minutes out.',
    ...PRESETS_ANY,
  ],
  ENVIRONMENTAL_HAZARD: [
    'Fire crews are on the way. Stay low and get out if you can.',
    ...PRESETS_ANY,
  ],
  UNKNOWN: [...PRESETS_ANY],
};

type Props = {
  incident: Incident;
  onSend: (text: string) => void;
  onClear: () => void;
};

/** Remounts when the selected incident changes so the draft field resets. */
export function CallerMessageSection({ incident, onSend, onClear }: Props) {
  return <CallerMessageForm key={incident._id} incident={incident} onSend={onSend} onClear={onClear} />;
}

function CallerMessageForm({ incident, onSend, onClear }: Props) {
  const [draft, setDraft] = useState('');
  const existing = incident.dispatcherMessage;
  const resolved = incident.status === 'RESOLVED';
  const noSession = !incident.sessionId;
  const disabled = resolved || noSession;
  const disabledWhy = resolved
    ? 'Incident is resolved — messaging is disabled.'
    : noSession
      ? 'No live phone session — messaging is unavailable.'
      : null;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft('');
  }

  return (
    <section className="border-b border-neutral-800 px-4 py-3" aria-label="Message to caller">
      <h3 className={`${LABEL} mb-2`}>Message to caller</h3>

      {disabledWhy && <p className="mb-2 text-[12px] text-neutral-500">{disabledWhy}</p>}

      {existing && (
        <div className="mb-3 rounded-[2px] border border-neutral-700 bg-neutral-900/60 px-3 py-2">
          <p className="text-[14px] text-neutral-50">{existing.text}</p>
          <div className={`mt-1 flex flex-wrap gap-x-3 ${MONO} text-[11px] text-neutral-500`}>
            <span>Sent {clock(existing.sentAt)}</span>
            {existing.seenAt ? (
              <span className="text-neutral-300">Seen {clock(existing.seenAt)}</span>
            ) : (
              <span>Waiting for phone…</span>
            )}
          </div>
          {!disabled && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={onClear}
                className={`h-6 rounded-[2px] border border-neutral-700 px-2 text-[12px] text-neutral-300 hover:bg-neutral-800 ${FOCUS_RING}`}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={draft}
            maxLength={MAX_LEN}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
            placeholder={disabled ? 'Messaging unavailable' : 'Type a message…'}
            aria-label="Message to caller"
            className={`min-w-0 flex-1 rounded-[2px] border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[13px] text-neutral-100 placeholder:text-neutral-600 disabled:opacity-50 ${FOCUS_RING}`}
          />
          <button
            type="submit"
            disabled={disabled || !draft.trim()}
            aria-keyshortcuts="Enter"
            className={`flex h-[34px] shrink-0 items-center gap-2 rounded-[2px] border border-neutral-700 bg-neutral-900 px-2.5 text-neutral-100 hover:bg-neutral-800 disabled:opacity-40 ${FOCUS_RING}`}
          >
            Send
            <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] text-neutral-500`}>Enter</kbd>
          </button>
        </div>
        <div className={`flex justify-end ${MONO} text-[11px] text-neutral-600`}>
          {draft.length}/{MAX_LEN}
        </div>
      </form>

      {!disabled && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRESETS_BY_TYPE[incident.crisisType].map((preset) => (
            <PresetButton key={preset} onClick={() => setDraft(preset.slice(0, MAX_LEN))}>
              {preset}
            </PresetButton>
          ))}
        </div>
      )}
    </section>
  );
}

function PresetButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`max-w-full truncate rounded-[2px] border border-neutral-700 px-2 py-1 text-left text-[11px] text-neutral-300 hover:bg-neutral-800 ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
function clock(iso: string) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : '—';
}
