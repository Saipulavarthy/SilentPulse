'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEMO_PREAMBLE,
  alertWasPlaced,
  contactPhone,
  ineligibleReason,
  lastFour,
  latestCall,
  scriptFacts,
  spokenText,
  templateScript,
} from '@/lib/contactCall';
import {
  CONTACT_CALL_ACTIVE,
  type ContactCall,
  type ContactCallKind,
  type ContactCallStateResponse,
  type ContactCallStatus,
  type ContactDraftResponse,
  type PlaceContactCallResponse,
} from '@/types/contactCall';
import type { Incident } from '@/types/incident';
import type { FeedMode } from './useIncidentFeed';

const POLL_MS = 3000;

export type ContactAvailability = {
  configured: boolean;
  allowlisted: boolean;
  /** False on a Twilio trial (template mode): Twilio's own message is played instead of the script. */
  customScript: boolean;
};

/** The inline review: nothing is sent until the dispatcher presses "Place call". */
export type ContactReview = {
  incidentId: string;
  kind: ContactCallKind;
  /** Second call of the same kind ("Call again"). */
  force: boolean;
  /** Building name the script may use (confirmed or the single one in range). */
  building: string | null;
  phase: 'loading' | 'ready' | 'placing' | 'error';
  preamble: string | null;
  script: string;
  source?: 'ai' | 'template' | 'simulated';
  model?: string;
  templateReason?: string;
  error?: string;
};

/** Merge the polled incident's calls with fresher local copies (same kind + requestedAt). */
function mergeCalls(server: ContactCall[] | undefined, local: ContactCall[] | undefined): ContactCall[] {
  const byKey = new Map<string, ContactCall>();
  for (const c of [...(server ?? []), ...(local ?? [])]) {
    const key = `${c.kind}|${c.requestedAt}`;
    const prev = byKey.get(key);
    if (!prev || Date.parse(c.updatedAt) >= Date.parse(prev.updatedAt)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
}

/** Which call the contact gets next: the all-clear once resolved after an alert, otherwise the alert. */
export function nextCallKind(incident: Incident, calls: ContactCall[]): ContactCallKind {
  return incident.status === 'RESOLVED' && alertWasPlaced(calls) ? 'allClear' : 'alert';
}

/** Why this kind of call can't be placed right now, ignoring earlier calls (handled by "Call again"). */
export function callBlockReason(
  incident: Incident,
  availability: ContactAvailability | undefined,
  calls: ContactCall[],
  kind: ContactCallKind,
): string | null {
  const reason = ineligibleReason({ ...incident, contactCalls: calls }, kind);
  if (reason) return reason;
  if (!availability) return 'Checking whether calling is available…';
  if (!availability.configured) return 'Calling not configured.';
  if (!availability.allowlisted) return 'Number not on allowlist.';
  return null;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

/** GET: availability plus the call log, with the latest call's status refreshed from Twilio. */
async function fetchCallState(id: string): Promise<Extract<ContactCallStateResponse, { ok: true }> | null> {
  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/notify-contact`, { cache: 'no-store' });
    const body = await readJson<ContactCallStateResponse>(res);
    return body?.ok ? body : null;
  } catch {
    return null; // network blip: the next poll tries again
  }
}

export function useContactCalls(mode: FeedMode | null, incidents: Incident[], selectedId: string | null) {
  const [local, setLocal] = useState<Record<string, ContactCall[]>>({});
  const [availability, setAvailability] = useState<Record<string, ContactAvailability>>({});
  const [review, setReview] = useState<ContactReview | null>(null);
  /** Guards against a late draft response landing on a newer review. */
  const reviewToken = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const callsFor = useCallback((incident: Incident) => mergeCalls(incident.contactCalls, local[incident._id]), [local]);
  const availabilityFor = useCallback(
    (id: string): ContactAvailability | undefined => (mode === 'mock' ? { configured: true, allowlisted: true, customScript: true } : availability[id]),
    [mode, availability],
  );

  const apply = useCallback((id: string, body: Extract<ContactCallStateResponse, { ok: true }>) => {
    setAvailability((prev) => ({ ...prev, [id]: { configured: body.configured, allowlisted: body.allowlisted, customScript: body.customScript } }));
    setLocal((prev) => ({ ...prev, [id]: mergeCalls(prev[id], body.calls) }));
  }, []);
  const refresh = useCallback(
    async (id: string) => {
      const body = await fetchCallState(id);
      if (body) apply(id, body);
    },
    [apply],
  );

  // Availability for the selected incident (live only).
  useEffect(() => {
    if (mode !== 'live' || !selectedId) return;
    let stale = false;
    void fetchCallState(selectedId).then((body) => {
      if (body && !stale) apply(selectedId, body);
    });
    return () => {
      stale = true;
    };
  }, [mode, selectedId, apply]);

  // Poll every 3 s while any call is still queued, ringing or in progress (live only).
  const activeIds = useMemo(
    () =>
      incidents
        .filter((i) => {
          const last = latestCall(mergeCalls(i.contactCalls, local[i._id]));
          return last !== null && CONTACT_CALL_ACTIVE.includes(last.status) && last.callSid !== '';
        })
        .map((i) => i._id)
        .join(','),
    [incidents, local],
  );
  useEffect(() => {
    if (mode !== 'live' || !activeIds) return;
    const ids = activeIds.split(',');
    const t = setInterval(() => ids.forEach((id) => void refresh(id)), POLL_MS);
    return () => clearInterval(t);
  }, [mode, activeIds, refresh]);

  /** Opens the review with a drafted script (simulated in mock mode). */
  const openReview = useCallback(
    async (incident: Incident, kind: ContactCallKind, building: string | null, force = false) => {
      const token = ++reviewToken.current;
      const base = { incidentId: incident._id, kind, force, building, preamble: null, script: '' };
      if (mode === 'mock') {
        setReview({
          ...base,
          phase: 'ready',
          preamble: DEMO_PREAMBLE,
          script: templateScript(scriptFacts(incident, kind, building)),
          source: 'simulated',
          templateReason: 'Simulated with mock data: template script, no API calls.',
        });
        return;
      }
      setReview({ ...base, phase: 'loading' });
      let next: ContactReview;
      try {
        const res = await fetch(`/api/incidents/${encodeURIComponent(incident._id)}/notify-contact/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, building }),
        });
        const body = await readJson<ContactDraftResponse>(res);
        next = body?.ok
          ? { ...base, phase: 'ready', preamble: body.preamble, script: body.script, source: body.source, model: body.model, templateReason: body.templateReason }
          : { ...base, phase: 'error', error: body?.message ?? `Draft failed (HTTP ${res.status}).` };
      } catch {
        next = { ...base, phase: 'error', error: 'Could not reach the server to draft the script.' };
      }
      if (token === reviewToken.current) setReview(next);
    },
    [mode],
  );

  const editScript = useCallback((script: string) => setReview((r) => (r ? { ...r, script } : r)), []);
  const cancelReview = useCallback(() => {
    reviewToken.current++;
    setReview(null);
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }, []);

  /** Mock: queued → ringing → answered → completed (or no answer for odd numbers, first try). */
  const simulate = useCallback((id: string, call: ContactCall, answered: boolean) => {
    const set = (patch: Partial<ContactCall>) =>
      setLocal((prev) => ({
        ...prev,
        [id]: (prev[id] ?? []).map((c) => (c.requestedAt === call.requestedAt && c.kind === call.kind ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c)),
      }));
    const at = (ms: number, status: ContactCallStatus, extra: Partial<ContactCall> = {}) =>
      timers.current.push(setTimeout(() => set({ status, ...extra }), ms));
    at(1500, 'ringing');
    if (answered) {
      at(5000, 'in-progress', { answeredAt: new Date(Date.now() + 5000).toISOString() });
      at(12000, 'completed');
    } else {
      at(9000, 'no-answer');
    }
  }, []);

  /** Places the reviewed call. */
  const place = useCallback(
    async (incident: Incident) => {
      if (!review || review.incidentId !== incident._id || review.phase === 'placing' || review.phase === 'loading') return;
      const r = review;
      window.speechSynthesis?.cancel();
      if (mode === 'mock') {
        const phone = contactPhone(incident) ?? '';
        const now = new Date().toISOString();
        const call: ContactCall = {
          kind: r.kind,
          status: 'queued',
          to: lastFour(phone),
          script: spokenText(r.preamble, r.script),
          spoken: 'script',
          callSid: 'SIMULATED',
          requestedAt: now,
          updatedAt: now,
        };
        setLocal((prev) => ({ ...prev, [incident._id]: [...(prev[incident._id] ?? []), call] }));
        simulate(incident._id, call, r.force || Number(phone.slice(-1)) % 2 === 0);
        setReview(null);
        return;
      }
      setReview({ ...r, phase: 'placing', error: undefined });
      try {
        const res = await fetch(`/api/incidents/${encodeURIComponent(incident._id)}/notify-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: r.kind, script: r.script, force: r.force, building: r.building }),
        });
        const body = await readJson<PlaceContactCallResponse>(res);
        if (body?.ok) {
          setLocal((prev) => ({ ...prev, [incident._id]: mergeCalls(prev[incident._id], [body.call]) }));
          setReview(null);
          return;
        }
        setReview({ ...r, phase: 'error', error: body?.message ?? `Call failed (HTTP ${res.status}).` });
        void refresh(incident._id); // a Twilio rejection is recorded as a failed call
      } catch {
        setReview({ ...r, phase: 'error', error: 'Could not reach the server. The call was not placed.' });
      }
    },
    [mode, review, simulate, refresh],
  );

  /** Deleted incidents: drop their local call state and any open review. */
  const forget = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    const omit = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !gone.has(k)));
    setLocal(omit);
    setAvailability(omit);
    setReview((r) => (r && gone.has(r.incidentId) ? null : r));
  }, []);

  return { callsFor, availabilityFor, review, openReview, editScript, cancelReview, place, forget, simulated: mode === 'mock' };
}
