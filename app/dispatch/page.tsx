'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { IncidentStatus } from '@/types/incident';
import { IncidentDetail } from '@/components/dispatch/IncidentDetail';
import { IncidentQueue } from '@/components/dispatch/IncidentQueue';
import { MapPanel } from '@/components/dispatch/MapPanel';
import { TopBar } from '@/components/dispatch/TopBar';
import { FILTERS, applyFilter, type QueueFilter } from '@/components/dispatch/severity';
import { useClock } from '@/components/dispatch/useClock';
import { useIncidentFeed } from '@/components/dispatch/useIncidentFeed';
import type { CopyState } from '@/components/dispatch/ResponsePlanSection';
import { planContext, useResponsePlans } from '@/components/dispatch/useResponsePlans';
import { MONO } from '@/components/dispatch/ui';

export default function DispatchPage() {
  // Live /api/incidents every 2 s, or mock data at ?mock=1 only.
  const { incidents, sync, setStatus: saveStatus, mutationError, clearMutationError } = useIncidentFeed();
  const [filter, setFilter] = useState<QueueFilter>('open');
  // null until the dispatcher picks one; until then the top open incident is selected.
  // Selection is by _id, so it stays on the same incident while polls reorder the list.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const { now } = useClock(1000);

  const visible = useMemo(() => applyFilter(incidents, filter), [incidents, filter]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, applyFilter(incidents, f.key).length])) as Record<QueueFilter, number>,
    [incidents],
  );
  const selectedId = pickedId ?? applyFilter(incidents, 'open')[0]?._id ?? null;
  const selected = incidents.find((i) => i._id === selectedId) ?? null;
  const { plans, generate, prefetch, ticks, toggleTick } = useResponsePlans();
  const [copied, setCopied] = useState<{ id: string; state: CopyState } | null>(null);

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
    if (selected) generate(selected, planContext(selected, incidents));
  }

  // Background plans for severity ≥ 7 incidents that are new or changed. This reacts to the
  // incident list changing; it is deliberately not called from inside the polling fetch.
  useEffect(() => {
    prefetch(incidents);
  }, [incidents, prefetch]);

  function changeFilter(next: QueueFilter) {
    setFilter(next);
    const list = applyFilter(incidents, next);
    if (!list.some((i) => i._id === selectedId)) setPickedId(list[0]?._id ?? selectedId);
  }

  function moveSelection(delta: 1 | -1) {
    if (visible.length === 0) return;
    const idx = visible.findIndex((i) => i._id === selectedId);
    const next = idx === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + delta));
    setPickedId(visible[next]._id);
  }

  /** Optimistic status change; if the incident leaves the current view, select the row that took its place. */
  function setStatus(status: IncidentStatus) {
    if (!selected) return;
    if (status === 'ACKNOWLEDGED' && selected.status !== 'ACTIVE') return;
    if (status === 'RESOLVED' && selected.status === 'RESOLVED') return;

    const nextVisible = applyFilter(
      incidents.map((i) => (i._id === selected._id ? { ...i, status } : i)),
      filter,
    );
    if (!nextVisible.some((i) => i._id === selected._id) && nextVisible.length > 0) {
      const idx = visible.findIndex((i) => i._id === selected._id);
      setPickedId(nextVisible[Math.min(Math.max(idx, 0), nextVisible.length - 1)]._id);
    }
    void saveStatus(selected._id, status);
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    // Leave typing and the map's own arrow-key panning alone.
    if (target?.closest('input, textarea, select, [contenteditable="true"], .maplibregl-map')) return;

    switch (e.key.toLowerCase()) {
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
        setStatus('ACKNOWLEDGED');
        break;
      case 'r':
        setStatus('RESOLVED');
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
      <TopBar incidents={incidents} now={now} sync={sync} />
      {mutationError && (
        <div role="alert" className={`flex shrink-0 items-center justify-between gap-3 border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-[12px] text-red-200 ${MONO}`}>
          <span>{mutationError}</span>
          <button type="button" onClick={clearMutationError} className="text-red-300 hover:text-red-100">
            Dismiss
          </button>
        </div>
      )}
      <main className="grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)_360px]">
        <IncidentQueue
          incidents={visible}
          counts={counts}
          filter={filter}
          onFilter={changeFilter}
          selectedId={selectedId}
          onSelect={setPickedId}
          now={now}
        />
        <MapPanel incidents={incidents} selectedId={selectedId} onSelect={setPickedId} />
        <IncidentDetail
          incident={selected}
          now={now}
          onAcknowledge={() => setStatus('ACKNOWLEDGED')}
          onResolve={() => setStatus('RESOLVED')}
          plan={selected ? plans[selected._id] : undefined}
          onGeneratePlan={generatePlan}
          ticked={selected ? (ticks[selected._id] ?? []) : []}
          onToggleTick={(action) => selected && toggleTick(selected._id, action)}
          onCopyBrief={() => void copyBrief()}
          copyState={copied && copied.id === selected?._id ? copied.state : null}
        />
      </main>
    </>
  );
}
