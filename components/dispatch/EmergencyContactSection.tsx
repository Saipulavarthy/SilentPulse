'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  SCRIPT_WORD_LIMIT,
  contactPhone,
  countWords,
  lastFour,
  latestCall,
  scriptCheckFor,
  scriptFacts,
  spokenText,
  validateScript,
} from '@/lib/contactCall';
import { CONTACT_CALL_ACTIVE, CONTACT_CALL_RETRYABLE, type ContactCall } from '@/types/contactCall';
import type { Incident } from '@/types/incident';
import { ActionButton, ConfirmButtons } from './StatusActions';
import { FOCUS_RING, LABEL, MONO } from './ui';
import { callBlockReason, nextCallKind, type ContactAvailability, type ContactReview } from './useContactCalls';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
};
const KIND_LABEL = { alert: 'Alert call', allClear: 'All-clear call' } as const;

/** "Ringing", "Connected 21:58", "No answer"… ("Connected": answered, possibly by voicemail.) */
export function callStatusText(c: ContactCall): string {
  switch (c.status) {
    case 'queued':
      return 'Queued';
    case 'ringing':
      return 'Ringing';
    case 'in-progress':
      return c.answeredAt ? `Connected ${hhmm(c.answeredAt)}` : 'Connected';
    case 'completed':
      return c.answeredAt ? `Connected ${hhmm(c.answeredAt)} · ended` : 'Completed';
    case 'busy':
      return 'Busy';
    case 'no-answer':
      return 'No answer';
    case 'canceled':
      return 'Canceled';
    default:
      return c.callSid ? 'Failed' : 'Failed: not placed';
  }
}

/** One line for the full-screen card, or null when no call has been made. */
export function contactStatusLine(calls: ContactCall[]): string | null {
  const last = latestCall(calls);
  return last ? `${KIND_LABEL[last.kind]}: ${callStatusText(last)}` : null;
}

type Props = {
  incident: Incident;
  calls: ContactCall[];
  availability: ContactAvailability | undefined;
  /** Open review for this incident, if any. */
  review: ContactReview | null;
  simulated: boolean;
  /** Opens the review for the next call (force = "Call again"). */
  onOpenReview: (force: boolean) => void;
  onEditScript: (script: string) => void;
  onPlace: () => void;
  onCancel: () => void;
};

export function EmergencyContactSection({ incident, calls, availability, review, simulated, onOpenReview, onEditScript, onPlace, onCancel }: Props) {
  const [confirmAgain, setConfirmAgain] = useState(false);
  const contact = incident.iceProfile?.emergencyContact;
  const phone = contactPhone(incident);
  const kind = nextCallKind(incident, calls);
  const latest = latestCall(calls, kind);
  const block = callBlockReason(incident, availability, calls, kind);
  const retryable = latest !== null && CONTACT_CALL_RETRYABLE.includes(latest.status);

  // "Call again?" takes Enter / Esc before the page's own shortcuts.
  useEffect(() => {
    if (!confirmAgain) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setConfirmAgain(false);
      if (e.key === 'Enter') onOpenReview(true);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [confirmAgain, onOpenReview]);

  return (
    <section className="border-b border-neutral-800 px-4 py-3" aria-label="Emergency contact">
      <h3 className={`${LABEL} mb-2 flex items-center gap-2`}>
        Emergency contact
        {simulated && <Tag>Simulated</Tag>}
      </h3>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Row label="Name">{contact?.name ?? <span className="text-neutral-500">Not given</span>}</Row>
        {contact?.relation && <Row label="Relation">{contact.relation}</Row>}
        <Row label="Phone">
          {phone ? <span className={MONO}>••• ••• {lastFour(phone)}</span> : <span className="text-neutral-500">None on file</span>}
        </Row>
      </dl>

      {calls.length > 0 && (
        <ol className="mt-2.5 list-none space-y-2 p-0" aria-label="Calls to the emergency contact">
          {calls.map((c) => (
            <CallRow key={`${c.kind}|${c.requestedAt}`} call={c} />
          ))}
        </ol>
      )}

      <div className="mt-3">
        {review ? (
          <Review incident={incident} review={review} customScript={availability?.customScript ?? true} onEdit={onEditScript} onPlace={onPlace} onCancel={onCancel} />
        ) : confirmAgain && latest ? (
          <div className="space-y-2" role="alertdialog" aria-label="Confirm call again">
            <p className="text-neutral-100">
              {`Call ${contact?.name ?? 'the contact'} again? The last ${kind === 'alert' ? 'alert' : 'all-clear'} call was: ${callStatusText(latest).toLowerCase()}.`}
            </p>
            <ConfirmButtons
              compact
              confirmLabel="Call again"
              onConfirm={() => {
                setConfirmAgain(false);
                onOpenReview(true);
              }}
              onCancel={() => setConfirmAgain(false)}
            />
          </div>
        ) : !latest ? (
          <>
            <ActionButton onClick={() => onOpenReview(false)} shortcut="Shift+C" compact disabled={block !== null}>
              {kind === 'alert' ? 'Call contact' : 'Call with the all-clear'}
            </ActionButton>
            {block && <p className="mt-1.5 text-[12px] text-neutral-500">{block}</p>}
          </>
        ) : retryable && !CONTACT_CALL_ACTIVE.includes(latest.status) ? (
          <>
            <ActionButton onClick={() => setConfirmAgain(true)} shortcut="" compact disabled={block !== null}>
              Call again
            </ActionButton>
            {block && <p className="mt-1.5 text-[12px] text-neutral-500">{block}</p>}
          </>
        ) : null}
      </div>
    </section>
  );
}

function CallRow({ call }: { call: ContactCall }) {
  const active = CONTACT_CALL_ACTIVE.includes(call.status);
  const bad = CONTACT_CALL_RETRYABLE.includes(call.status);
  return (
    <li className="rounded-[2px] border border-neutral-800 px-2.5 py-1.5">
      <div className={`flex flex-wrap items-baseline gap-x-2 ${MONO} text-[12px]`}>
        <span className="text-neutral-400">{KIND_LABEL[call.kind]}</span>
        <span className="text-neutral-500">{hhmm(call.requestedAt)}</span>
        <span className="text-neutral-500">to ••{call.to}</span>
        <span
          className={`ml-auto ${active ? 'text-sky-300' : bad ? 'text-amber-200' : 'text-neutral-100'}`}
          title={call.status === 'completed' || call.status === 'in-progress' ? 'Connected: answered by a person or possibly by voicemail' : undefined}
          aria-live="polite"
        >
          {active && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-400 align-middle motion-safe:animate-pulse" aria-hidden />}
          {callStatusText(call)}
        </span>
      </div>
      {call.callSid !== '' && (
        <p className={`mt-0.5 text-[12px] ${call.spoken === 'trialTemplate' ? 'text-amber-200' : 'text-neutral-400'}`}>
          {call.spoken === 'trialTemplate'
            ? 'Call placed: Twilio trial message (custom script needs an upgraded account)'
            : 'Call placed: spoken script'}
        </p>
      )}
      <details className="mt-1 text-[12px]">
        <summary className={`cursor-pointer text-neutral-500 hover:text-neutral-300 ${FOCUS_RING}`}>
          {call.spoken === 'trialTemplate' ? 'Reviewed script (not spoken)' : 'Script spoken'}
        </summary>
        <p className="mt-1 text-neutral-300">{call.script}</p>
      </details>
    </li>
  );
}

function Review({
  incident,
  review,
  customScript,
  onEdit,
  onPlace,
  onCancel,
}: {
  incident: Incident;
  review: ContactReview;
  customScript: boolean;
  onEdit: (s: string) => void;
  onPlace: () => void;
  onCancel: () => void;
}) {
  const [speaking, setSpeaking] = useState(false);
  const title = review.kind === 'alert' ? (review.force ? 'Call again: review the script' : 'Review the call script') : 'All-clear call: review the script';

  if (review.phase === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        <p className="text-[12px] text-neutral-400">Drafting the call script…</p>
        <ActionButton onClick={onCancel} shortcut="Esc" compact>
          Cancel
        </ActionButton>
      </div>
    );
  }

  const facts = scriptFacts(incident, review.kind, review.building);
  const problems = review.script.trim() ? validateScript(review.script, scriptCheckFor(incident, review.kind, facts, false)) : ['The script is empty.'];
  const words = countWords(review.script);
  const placing = review.phase === 'placing';

  function preview() {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const u = new SpeechSynthesisUtterance(spokenText(review.preamble, review.script));
    u.lang = 'en-US';
    u.rate = 0.95;
    const voices = synth.getVoices().filter((v) => v.lang === 'en-US');
    u.voice = voices.find((v) => /natural|neural|enhanced|premium|samantha|google us/i.test(v.name)) ?? voices[0] ?? null;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  }

  return (
    <div className="space-y-2" role="group" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-neutral-200">{title}</span>
        <span className={`${MONO} text-[11px] text-neutral-500`}>
          {review.source === 'ai' ? `Gemini · ${review.model ?? ''}` : review.source === 'simulated' ? 'Simulated' : 'Template'}
        </span>
      </div>
      {review.templateReason && review.source !== 'ai' && <p className="text-[11px] text-neutral-500">{review.templateReason}</p>}
      {!customScript && (
        <p className="rounded-[2px] border border-amber-400/40 px-2 py-1 text-[12px] text-amber-200">
          Twilio trial account: the call plays Twilio&apos;s own trial message. This script is checked and kept with the call, but it is not spoken
          until the account is upgraded.
        </p>
      )}
      {review.preamble && (
        <p className="rounded-[2px] border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[12px] text-neutral-400">
          <span className={`${LABEL} mr-1.5`}>Spoken first</span>
          {review.preamble}
        </p>
      )}
      <textarea
        value={review.script}
        onChange={(e) => onEdit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        disabled={placing}
        rows={6}
        aria-label="Call script"
        className={`block w-full resize-y rounded-[2px] border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-[13px] leading-snug text-neutral-100 disabled:opacity-60 ${FOCUS_RING}`}
      />
      <div className={`flex items-center justify-between ${MONO} text-[11px]`}>
        <span className="text-neutral-500">{customScript ? 'Spoken twice, with a pause between.' : 'Not spoken on a trial account.'}</span>
        <span className={words > SCRIPT_WORD_LIMIT ? 'text-red-300' : 'text-neutral-500'}>
          {words}/{SCRIPT_WORD_LIMIT} words
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="list-none space-y-0.5 p-0 text-[12px] text-amber-200">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {review.phase === 'error' && review.error && (
        <p role="alert" className="text-[12px] text-red-300">
          {review.error}
        </p>
      )}
      <ActionButton onClick={preview} shortcut="" compact disabled={placing || !review.script.trim()}>
        {speaking ? 'Stop preview' : 'Preview voice'}
      </ActionButton>
      <div className="grid grid-cols-2 gap-2">
        <ActionButton onClick={onPlace} shortcut="" compact tone="danger" disabled={placing || problems.length > 0}>
          {placing ? 'Placing call…' : 'Place call'}
        </ActionButton>
        <ActionButton onClick={onCancel} shortcut="Esc" compact disabled={placing}>
          Cancel
        </ActionButton>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{children}</dd>
    </>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className={`rounded-[2px] border border-amber-400/60 px-1 text-[10px] tracking-[0.06em] text-amber-200 uppercase ${MONO}`}>
      {children}
    </span>
  );
}
