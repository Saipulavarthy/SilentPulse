'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { Incident, IncidentStatus } from '@/types/incident';
import { IncidentDetail } from '@/components/dispatch/IncidentDetail';
import { IncidentQueue } from '@/components/dispatch/IncidentQueue';
import { MapPanel } from '@/components/dispatch/MapPanel';
import { TopBar } from '@/components/dispatch/TopBar';
import { FILTERS, applyFilter, type QueueFilter } from '@/components/dispatch/severity';
import { useClock } from '@/components/dispatch/useClock';
import { mockIncidents } from './mockIncidents';

export default function DispatchPage() {
  // Mock data only until the API is ready. Status changes are local state.
  const [incidents, setIncidents] = useState<Incident[]>(mockIncidents);
  const [filter, setFilter] = useState<QueueFilter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => applyFilter(mockIncidents, 'open')[0]?._id ?? null,
  );
  const { now, startedAt } = useClock(1000);

  const visible = useMemo(() => applyFilter(incidents, filter), [incidents, filter]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, applyFilter(incidents, f.key).length])) as Record<QueueFilter, number>,
    [incidents],
  );
  const selected = incidents.find((i) => i._id === selectedId) ?? null;

  function changeFilter(next: QueueFilter) {
    setFilter(next);
    const list = applyFilter(incidents, next);
    if (!list.some((i) => i._id === selectedId)) setSelectedId(list[0]?._id ?? selectedId);
  }

  function moveSelection(delta: 1 | -1) {
    if (visible.length === 0) return;
    const idx = visible.findIndex((i) => i._id === selectedId);
    const next = idx === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + delta));
    setSelectedId(visible[next]._id);
  }

  /** Updates status; if the incident leaves the current view, select the row that took its place. */
  function setStatus(status: IncidentStatus) {
    if (!selected) return;
    if (status === 'ACKNOWLEDGED' && selected.status !== 'ACTIVE') return;
    if (status === 'RESOLVED' && selected.status === 'RESOLVED') return;

    const updatedAt = new Date().toISOString();
    const nextIncidents = incidents.map((i) => (i._id === selected._id ? { ...i, status, updatedAt } : i));
    setIncidents(nextIncidents);

    const nextVisible = applyFilter(nextIncidents, filter);
    if (!nextVisible.some((i) => i._id === selected._id) && nextVisible.length > 0) {
      const idx = visible.findIndex((i) => i._id === selected._id);
      setSelectedId(nextVisible[Math.min(Math.max(idx, 0), nextVisible.length - 1)]._id);
    }
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
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <TopBar incidents={incidents} now={now} syncedAt={startedAt} />
      <main className="grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)_360px]">
        <IncidentQueue
          incidents={visible}
          counts={counts}
          filter={filter}
          onFilter={changeFilter}
          selectedId={selectedId}
          onSelect={setSelectedId}
          now={now}
        />
        <MapPanel incidents={incidents} selectedId={selectedId} onSelect={setSelectedId} />
        <IncidentDetail
          incident={selected}
          now={now}
          onAcknowledge={() => setStatus('ACKNOWLEDGED')}
          onResolve={() => setStatus('RESOLVED')}
        />
      </main>
    </>
  );
}
