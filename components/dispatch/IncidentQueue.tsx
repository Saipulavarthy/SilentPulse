'use client';

import { useEffect } from 'react';
import type { Incident } from '@/types/incident';
import {
  FILTERS,
  STATUS_SHORT,
  elapsed,
  incidentNumber,
  isReview,
  tierStyle,
  typeLabel,
  type QueueFilter,
} from './severity';
import { SeveritySquare } from './SeveritySquare';
import { ACCENT_BG, ACCENT_TEXT, FOCUS_RING, LABEL, MONO } from './ui';

type Props = {
  /** Filtered and sorted for display. */
  incidents: Incident[];
  counts: Record<QueueFilter, number>;
  filter: QueueFilter;
  onFilter: (f: QueueFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number | null;
};

const COLS = 'grid grid-cols-[22px_58px_124px_minmax(0,1fr)_58px_72px] items-center gap-x-1.5';
const rowId = (id: string) => `queue-row-${id}`;

export function IncidentQueue({ incidents, counts, filter, onFilter, selectedId, onSelect, now }: Props) {
  useEffect(() => {
    if (selectedId) document.getElementById(rowId(selectedId))?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const selectedVisible = incidents.some((i) => i._id === selectedId);

  return (
    <section className="flex min-h-0 flex-col border-r border-neutral-800" aria-label="Incident queue">
      <div role="tablist" aria-label="Queue filter" className="flex h-9 shrink-0 items-end gap-4 border-b border-neutral-800 px-3">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onFilter(f.key)}
              className={`-mb-px border-b-2 pb-2 text-[11px] font-medium uppercase tracking-[0.06em] ${FOCUS_RING} ${
                active ? `border-sky-400 ${ACCENT_TEXT}` : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {f.label} <span className={MONO}>{counts[f.key]}</span>
            </button>
          );
        })}
      </div>

      <div className={`${COLS} h-7 shrink-0 border-b border-neutral-800 pr-3 pl-[15px] ${LABEL}`} aria-hidden>
        <span>Sev</span>
        <span>ID</span>
        <span>Type</span>
        <span>Location</span>
        <span className="text-right">Elapsed</span>
        <span>Status</span>
      </div>

      <div
        role="listbox"
        aria-label="Incidents"
        aria-activedescendant={selectedVisible && selectedId ? rowId(selectedId) : undefined}
        tabIndex={0}
        className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_RING}`}
      >
        {incidents.length === 0 && (
          <div className="px-3 py-6 text-center text-neutral-600">No incidents in this view.</div>
        )}
        {incidents.map((incident) => {
          const t = tierStyle(incident.severityScore);
          const selected = incident._id === selectedId;
          const review = isReview(incident);
          return (
            <div
              key={incident._id}
              id={rowId(incident._id)}
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(incident._id)}
              className={`${COLS} h-9 cursor-default border-b border-l-[3px] border-b-neutral-900 pr-3 pl-3 ${t.edge} ${
                selected
                  ? `${ACCENT_BG} text-neutral-50 outline outline-1 -outline-offset-1 outline-sky-400/50`
                  : 'hover:bg-neutral-900'
              } ${review && !selected ? 'opacity-55' : ''}`}
            >
              <SeveritySquare score={incident.severityScore} />
              <span className={`${MONO} text-[12px] ${selected ? 'text-neutral-100' : 'text-neutral-400'}`}>
                {incidentNumber(incident._id)}
              </span>
              <span className="truncate">{typeLabel(incident)}</span>
              <span className="truncate text-neutral-400">{incident.building?.name ?? 'Unknown location'}</span>
              <span className={`${MONO} text-right text-[12px]`}>{elapsed(incident.createdAt, now)}</span>
              <span className={`flex items-center gap-1.5 ${MONO} text-[10px]`}>
                <span className={incident.status === 'ACTIVE' ? 'text-neutral-200' : 'text-neutral-500'}>
                  {STATUS_SHORT[incident.status]}
                </span>
                {review && (
                  <span className="rounded-[2px] border border-neutral-600 px-1 leading-[14px] text-neutral-400">
                    REVIEW
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className={`flex h-7 shrink-0 items-center gap-3 border-t border-neutral-800 px-3 ${MONO} text-[10px] text-neutral-600`}>
        <span>↑↓ / J K select</span>
        <span>A acknowledge</span>
        <span>R resolve</span>
      </div>
    </section>
  );
}
