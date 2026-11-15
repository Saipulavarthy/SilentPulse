'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { IncidentStatus } from '@/types/incident';
import { EmergencyContactSection, contactStatusLine } from '@/components/dispatch/EmergencyContactSection';
import { FloatingDetail, FloatingQueue } from '@/components/dispatch/FloatingPanels';
import { IncidentDetail } from '@/components/dispatch/IncidentDetail';
import {
  phoneStillSending,
  resolveNeedsConfirm,
  staleReopenMinutes,
  type PendingConfirm,
  type StatusActionHandlers,
} from '@/components/dispatch/StatusActions';
import { IncidentQueue } from '@/components/dispatch/IncidentQueue';
import { MapPanel } from '@/components/dispatch/MapPanel';
import { TopBar } from '@/components/dispatch/TopBar';
import { FILTERS, applyFilter, type QueueFilter } from '@/components/dispatch/severity';
import { useClock } from '@/components/dispatch/useClock';
import { useIncidentFeed } from '@/components/dispatch/useIncidentFeed';
import { useIncidentLocations } from '@/components/dispatch/useIncidentLocations';
import { callBlockReason, nextCallKind, useContactCalls } from '@/components/dispatch/useContactCalls';
import { alertWasPlaced, latestCall } from '@/lib/contactCall';
import type { CopyState } from '@/components/dispatch/ResponsePlanSection';
import { planContext, useResponsePlans } from '@/components/dispatch/useResponsePlans';
import { MONO } from '@/components/dispatch/ui';

export default function DispatchPage() {
  // Live /api/incidents every 2 s, or mock data at ?mock=1 only.
  const {
    mode,
    incidents,
    sync,
    setStatus: saveStatus,
    setDispatcherMessage: saveDispatcherMessage,
    deleteIncidents,
    mutationError,
    clearMutationError,
  } = useIncidentFeed();
  const [filter, setFilter] = useState<QueueFilter>('open');
  // null until the dispatcher picks one; until then the top open incident is selected.
  // Selection is by _id, so it stays on the same incident while polls reorder the list.
  const [pickedId, setPickedId] = useState<string | null>(null);
  // Full-screen map (F / Esc). Camera and selection live outside this, so both are kept.
  const [fullscreen, setFullscreen] = useState(false);
  const [floatCollapsed, setFloatCollapsed] = useState({ queue: false, detail: false });
  /** Open confirmation (resolve, or reopen of a stale session), for one incident. */
  const [confirm, setConfirm] = useState<({ id: string } & PendingConfirm) | null>(null);
  /** "Delete all resolved" prompt open (Resolved tab). */
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [mapFocus, setMapFocus] = useState<{ lng: number; lat: number; token: number } | null>(null);
  const { now } = useClock(1000);

  const visible = useMemo(() => applyFilter(incidents, filter), [incidents, filter]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, applyFilter(incidents, f.key).length])) as Record<QueueFilter, number>,
    [incidents],
  );
  const selectedId = pickedId ?? applyFilter(incidents, 'open')[0]?._id ?? null;
  const selected = incidents.find((i) => i._id === selectedId) ?? null;
  const { locations, confirmBuilding, clearConfirmed, forget: forgetLocations } = useIncidentLocations(incidents, now);
  const { plans, generate, prefetch, ticks, toggleTick, forget: forgetPlans } = useResponsePlans();
  const [copied, setCopied] = useState<{ id: string; state: CopyState } | null>(null);
  const contact = useContactCalls(mode, incidents, selectedId);
  /** "Also call the contact with the all-clear?" in the resolve confirmation. Off by default. */
  const [allClearOptIn, setAllClearOptIn] = useState(false);

  /** A building name the call script may use: only a confirmed one or the single one in range. */
  function certainBuilding(id: string): string | null {
    const loc = locations.get(id);
    return loc && (loc.confidence === 'confirmed' || loc.confidence === 'single') ? (loc.shown[0]?.name ?? null) : null;
  }

  /** Shift+C: opens the review for the next call. "Call again" goes through its own confirmation. */
  function callContact() {
    if (!selected) return;
    const calls = contact.callsFor(selected);
    const kind = nextCallKind(selected, calls);
    if (latestCall(calls, kind) || callBlockReason(selected, contact.availabilityFor(selected._id), calls, kind)) return;
    void contact.openReview(selected, kind, certainBuilding(selected._id));
  }

  /** Copies the selected incident's radio brief (button or C). */
  async function copyBrief() {
    const entry = selected ? plans[selected._id] : undefined;
    if (!selected || entry?.status !== 'ready') return;
    const id = selected._id;
    try {
      await navigator.clipboard.writeText(entry.plan.radioBrief);
      setCopied({ id, state: 'copied' });
    } catch {
      setCopied({ id, state: 'failed' });
    }
  }

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!mutationError) return;
    const t = setTimeout(clearMutationError, 8000);
    return () => clearTimeout(t);
  }, [mutationError, clearMutationError]);

  /** On demand (button or G): plan for the selected incident, any severity. */
  function generatePlan() {
    if (selected) generate(selected, planContext(selected, incidents, locations));
  }

  // Background plans for severity ≥ 7 incidents that are new or changed. This reacts to the
  // incident list changing; it is deliberately not called from inside the polling fetch.
  useEffect(() => {
    prefetch(incidents, locations);
  }, [incidents, locations, prefetch]);

  function changeFilter(next: QueueFilter) {
    setFilter(next);
    setBulkConfirm(false);
    const list = applyFilter(incidents, next);
    if (!list.some((i) => i._id === selectedId)) setPickedId(list[0]?._id ?? selectedId);
  }

  function moveSelection(delta: 1 | -1) {
    if (visible.length === 0) return;
    const idx = visible.findIndex((i) => i._id === selectedId);
    const next = idx === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + delta));
    select(visible[next]._id);
  }

  /** Optimistic status change; if the incident leaves the current view, select the row that took its place. */
  function changeStatus(id: string, status: IncidentStatus, verb: string): Promise<boolean> {
    const target = incidents.find((i) => i._id === id);
    if (!target || target.status === status) return Promise.resolve(false);
    setConfirm(null);
    if (id === selectedId) {
      const nextVisible = applyFilter(
        incidents.map((i) => (i._id === id ? { ...i, status } : i)),
        filter,
      );
      if (!nextVisible.some((i) => i._id === id) && nextVisible.length > 0) {
        const idx = visible.findIndex((i) => i._id === id);
        setPickedId(nextVisible[Math.min(Math.max(idx, 0), nextVisible.length - 1)]._id);
      }
    }
    return saveStatus(id, status, verb);
  }

  const acknowledge = () => selected?.status === 'ACTIVE' && changeStatus(selected._id, 'ACKNOWLEDGED', 'acknowledge');
  const unacknowledge = () => selected?.status === 'ACKNOWLEDGED' && changeStatus(selected._id, 'ACTIVE', 'unacknowledge');
  /**
   * A live session last seen over 60 s ago is escalated by the API once it is ACTIVE again
   * (signal lost, severity 10), so ask first. Recent or session-less incidents reopen at once.
   */
  const reopen = (id = selected?._id) => {
    const target = incidents.find((i) => i._id === id);
    if (target?.status !== 'RESOLVED') return;
    const minutes = staleReopenMinutes(target, Date.now());
    if (minutes === null) return void changeStatus(target._id, 'ACTIVE', 'reopen');
    setPickedId(target._id); // the prompt shows in this incident's panel
    setConfirm({ id: target._id, kind: 'reopen', minutes });
  };
  /**
   * Severity ≥ 7, worsening or signal lost: ask first. Also ask when the emergency contact got an
   * alert call, to offer the all-clear call. Otherwise resolve at once.
   */
  const resolve = () => {
    if (!selected || selected.status === 'RESOLVED') return;
    const calls = contact.callsFor(selected);
    const offerAllClear = alertWasPlaced(calls) && !latestCall(calls, 'allClear');
    if ((resolveNeedsConfirm(selected) || offerAllClear) && confirm?.id !== selected._id) {
      setAllClearOptIn(false);
      setConfirm({ id: selected._id, kind: 'resolve', offerAllClear });
    } else void changeStatus(selected._id, 'RESOLVED', 'resolve');
  };
  const confirming: PendingConfirm | null = selected && confirm?.id === selected._id ? confirm : null;
  const confirmPending = () => {
    if (!selected || !confirming) return;
    if (confirming.kind === 'delete') void deleteOne(selected._id);
    else if (confirming.kind === 'reopen') void changeStatus(selected._id, 'ACTIVE', 'reopen');
    else {
      const target = selected;
      const saved = changeStatus(target._id, 'RESOLVED', 'resolve');
      // All-clear opted in: keep this incident selected and open its review once the resolve is saved.
      // Nothing is sent until the dispatcher presses "Place call".
      if (confirming.offerAllClear && allClearOptIn) {
        setPickedId(target._id);
        void saved.then((ok) => {
          if (ok) void contact.openReview({ ...target, status: 'RESOLVED' }, 'allClear', certainBuilding(target._id));
        });
      }
    }
  };

  /** Delete always asks, at any severity (button or Shift+D). */
  const requestDelete = () => {
    if (!selected) return;
    setBulkConfirm(false);
    setConfirm({ id: selected._id, kind: 'delete', stillSending: phoneStillSending(selected, Date.now()) });
  };

  /** Per-incident state kept outside the list: plans, ticks, confirmed buildings, copy feedback. */
  function forgetIncidents(ids: string[]) {
    forgetPlans(ids);
    forgetLocations(ids);
    contact.forget(ids);
    setCopied((c) => (c && ids.includes(c.id) ? null : c));
  }

  /** Removed at once (selection moves to the next row); restored with an error if the request fails. */
  async function deleteOne(id: string) {
    setConfirm(null);
    if (id === selectedId) {
      const idx = visible.findIndex((i) => i._id === id);
      const rest = visible.filter((i) => i._id !== id);
      setPickedId(rest.length ? rest[Math.min(Math.max(idx, 0), rest.length - 1)]._id : null);
    }
    const removed = await deleteIncidents({ kind: 'one', id }, [id]);
    if (removed) forgetIncidents(removed);
  }

  /** Delete all resolved, or every incident (reset demo). Clears the selection if it went. */
  async function deleteBulk(kind: 'resolved' | 'all') {
    setBulkConfirm(false);
    setConfirm(null);
    const ids = (kind === 'all' ? incidents : incidents.filter((i) => i.status === 'RESOLVED')).map((i) => i._id);
    if (selectedId && ids.includes(selectedId)) setPickedId(null);
    const removed = await deleteIncidents({ kind }, ids);
    if (removed) forgetIncidents(removed);
  }
  const bulkConfirming = bulkConfirm && filter === 'resolved' && counts.resolved > 0;

  const actions: StatusActionHandlers = {
    onAcknowledge: acknowledge,
    onUnacknowledge: unacknowledge,
    onResolve: resolve,
    onReopen: () => reopen(),
    onDelete: requestDelete,
    confirming,
    onConfirm: confirmPending,
    onCancelConfirm: () => setConfirm(null),
    allClearOptIn,
    onToggleAllClear: () => setAllClearOptIn((v) => !v),
  };

  function select(id: string) {
    setConfirm(null);
    setPickedId(id);
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = e.key.toLowerCase();
    // Leave the map's own arrow-key panning alone when it has focus.
    if (key.startsWith('arrow') && target?.closest('.maplibregl-map')) return;

    // An open call review: Esc cancels it (Enter never places a call).
    if (contact.review && key === 'escape') {
      e.preventDefault();
      contact.cancelReview();
      return;
    }
    // An open confirmation takes Enter and Esc first.
    if (bulkConfirming && (key === 'enter' || key === 'escape')) {
      e.preventDefault();
      if (key === 'enter') void deleteBulk('resolved');
      else setBulkConfirm(false);
      return;
    }
    if (confirming && (key === 'enter' || key === 'escape')) {
      e.preventDefault();
      if (key === 'enter') confirmPending();
      else setConfirm(null);
      return;
    }

    // Call the emergency contact: Shift+C (a plain C copies the radio brief).
    if (e.shiftKey && key === 'c') {
      e.preventDefault();
      callContact();
      return;
    }
    // Delete is Shift+D only; a plain D does nothing.
    if (e.shiftKey && key === 'd') {
      e.preventDefault();
      requestDelete();
      return;
    }

    switch (key) {
      case 'escape':
        if (fullscreen) setFullscreen(false);
        break;
      case 'f':
        setFullscreen((v) => !v);
        break;
      case 'o':
        reopen();
        break;
      case 'u':
        unacknowledge();
        break;
      case 'arrowdown':
      case 'j':
        e.preventDefault();
        moveSelection(1);
        break;
      case 'arrowup':
      case 'k':
        e.preventDefault();
        moveSelection(-1);
        break;
      case 'a':
        acknowledge();
        break;
      case 'r':
        resolve();
        break;
      case 'g':
        generatePlan();
        break;
      case 'c':
        void copyBrief();
        break;
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <TopBar incidents={incidents} now={now} sync={sync} onResetDemo={() => void deleteBulk('all')} />
      {mutationError && (
        <div role="alert" className={`flex shrink-0 items-center justify-between gap-3 border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-[12px] text-red-200 ${MONO}`}>
          <span>{mutationError}</span>
          <button type="button" onClick={clearMutationError} className="text-red-300 hover:text-red-100">
            Dismiss
          </button>
        </div>
      )}
      {/* Same child positions in both layouts, so the map (and its camera) is never remounted. */}
      <main className={fullscreen ? 'relative min-h-0 flex-1' : 'grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)_360px]'}>
        {fullscreen ? (
          <FloatingQueue
            incidents={visible}
            title={`Queue · ${FILTERS.find((f) => f.key === filter)?.label} ${visible.length}`}
            selectedId={selectedId}
            onSelect={select}
            collapsed={floatCollapsed.queue}
            onToggle={() => setFloatCollapsed((c) => ({ ...c, queue: !c.queue }))}
            locations={locations}
          />
        ) : (
          <IncidentQueue
            incidents={visible}
            counts={counts}
            filter={filter}
            onFilter={changeFilter}
            selectedId={selectedId}
            onSelect={select}
            now={now}
            onReopen={(id) => reopen(id)}
            locations={locations}
            bulkDelete={{
              confirming: bulkConfirming,
              onRequest: () => {
                setConfirm(null);
                setBulkConfirm(true);
              },
              onConfirm: () => void deleteBulk('resolved'),
              onCancel: () => setBulkConfirm(false),
            }}
          />
        )}
        <div className={fullscreen ? 'absolute inset-0' : 'relative min-h-0'}>
          <MapPanel
            incidents={incidents}
            selectedId={selectedId}
            onSelect={select}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
            locations={locations}
            focus={mapFocus}
          />
        </div>
        {fullscreen ? (
          <FloatingDetail
            incident={selected}
            plan={selected ? plans[selected._id] : undefined}
            collapsed={floatCollapsed.detail}
            onToggle={() => setFloatCollapsed((c) => ({ ...c, detail: !c.detail }))}
            actions={actions}
            location={selected ? locations.get(selected._id) : undefined}
            contactLine={selected ? contactStatusLine(contact.callsFor(selected)) : null}
          />
        ) : (
          <IncidentDetail
            incident={selected}
            now={now}
            actions={actions}
            plan={selected ? plans[selected._id] : undefined}
            onGeneratePlan={generatePlan}
            ticked={selected ? (ticks[selected._id] ?? []) : []}
            onToggleTick={(action) => selected && toggleTick(selected._id, action)}
            onCopyBrief={() => void copyBrief()}
            copyState={copied && copied.id === selected?._id ? copied.state : null}
            onSendCallerMessage={(text) => selected && void saveDispatcherMessage(selected._id, text)}
            onClearCallerMessage={() => selected && void saveDispatcherMessage(selected._id, '')}
            location={selected ? locations.get(selected._id) : undefined}
            onConfirmBuilding={(osmId) => selected && confirmBuilding(selected._id, osmId)}
            onClearConfirmedBuilding={() => selected && clearConfirmed(selected._id)}
            onFlyToBuilding={(lng, lat) => setMapFocus({ lng, lat, token: Date.now() })}
            contactSection={
              selected && (
                <EmergencyContactSection
                  incident={selected}
                  calls={contact.callsFor(selected)}
                  availability={contact.availabilityFor(selected._id)}
                  review={contact.review?.incidentId === selected._id ? contact.review : null}
                  simulated={contact.simulated}
                  onOpenReview={(force) =>
                    void contact.openReview(selected, nextCallKind(selected, contact.callsFor(selected)), certainBuilding(selected._id), force)
                  }
                  onEditScript={contact.editScript}
                  onPlace={() => void contact.place(selected)}
                  onCancel={contact.cancelReview}
                />
              )
            }
          />
        )}
      </main>
    </>
  );
}
