'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import {
  FILTERS,
  STATUS_SHORT,
  elapsed,
  incidentNumber,
  isReview,
  locationLabel,
  tierStyle,
  typeLabel,
  type QueueFilter,
} from './severity';
import { queueLocationLabel, type IncidentLocation } from './locationEstimate';
import { SeveritySquare } from './SeveritySquare';
import { ConfirmButtons } from './StatusActions';
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
  /** Shown as a Reopen button on rows in the Resolved tab. */
  onReopen: (id: string) => void;
  locations?: Map<string, IncidentLocation>;
  /** "Delete all resolved" in the Resolved tab; confirming = its prompt is open. */
  bulkDelete: { confirming: boolean; onRequest: () => void; onConfirm: () => void; onCancel: () => void };
};

const COLS =
  'grid grid-cols-[20px_68px_minmax(0,1.1fr)_minmax(0,1fr)_50px_70px] items-center gap-x-1.5';
const rowId = (id: string) => `queue-row-${id}`;

/**
 * Smooth reordering when incidents update in place (same _id, new severity or type): each row
 * that moved is shifted back to where it was and animated to its new place (FLIP).
 */
function useRowReorderAnimation(order: string) {
  const rows = useRef(new Map<string, HTMLElement>());
  const lastTop = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, number>();
    for (const [id, el] of rows.current) {
      const top = el.offsetTop;
      next.set(id, top);
      const before = lastTop.current.get(id);
      if (reduce || before === undefined || before === top) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${before - top}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 260ms ease';
        el.style.transform = '';
      });
    }
    lastTop.current = next;
  }, [order]);
  return (id: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  };
}

export function IncidentQueue({ incidents, counts, filter, onFilter, selectedId, onSelect, now, onReopen, locations, bulkDelete }: Props) {
  useEffect(() => {
    if (selectedId) document.getElementById(rowId(selectedId))?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  const rowRef = useRowReorderAnimation(incidents.map((i) => i._id).join(','));

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

      {filter === 'resolved' && counts.resolved > 0 && (
        <div className="shrink-0 border-b border-neutral-800 px-3 py-2">
          {bulkDelete.confirming ? (
            <div className="space-y-2" role="alertdialog" aria-label="Confirm delete all resolved">
              <p className="text-neutral-100">{`Delete ${counts.resolved} resolved incident${counts.resolved === 1 ? '' : 's'} permanently?`}</p>
              <ConfirmButtons onConfirm={bulkDelete.onConfirm} onCancel={bulkDelete.onCancel} compact danger />
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={bulkDelete.onRequest}
                className={`h-6 rounded-[2px] border border-red-900 bg-red-950/40 px-2 text-[12px] text-red-200 hover:bg-red-950 ${FOCUS_RING}`}
              >
                Delete all resolved ({counts.resolved})
              </button>
            </div>
          )}
        </div>
      )}

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
              ref={rowRef(incident._id)}
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
              <span className="flex min-w-0 items-center gap-1" title={typeLabel(incident)}>
                <span className="truncate">{typeLabel(incident)}</span>
                {incident.simulated && <RowTag>Sim</RowTag>}
              </span>
              {(() => {
                const loc = locations?.get(incident._id);
                const label = loc ? queueLocationLabel(loc) : { text: locationLabel(incident), title: locationLabel(incident) };
                return (
                  <span
                    className={`truncate ${incident.gps || incident.building || loc?.buildings.length ? 'text-neutral-400' : 'text-neutral-600'}`}
                    title={label.title}
                  >
                    {label.text}
                  </span>
                );
              })()}
              <span className={`${MONO} text-right text-[12px]`}>{elapsed(incident.createdAt, now)}</span>
              <span className={`flex items-center gap-1.5 ${MONO} text-[10px]`}>
                {filter === 'resolved' && incident.status === 'RESOLVED' ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReopen(incident._id);
                    }}
                    className={`rounded-[2px] border border-neutral-600 px-1 leading-[14px] text-neutral-200 hover:bg-neutral-800 ${FOCUS_RING}`}
                  >
                    REOPEN
                  </button>
                ) : (
                  <span className={incident.status === 'ACTIVE' ? 'text-neutral-200' : 'text-neutral-500'}>
                    {STATUS_SHORT[incident.status]}
                  </span>
                )}
                {incident.escalated ? (
                  <RowTag tone="alert">Lost</RowTag>
                ) : (
                  review && (
                    <span className="rounded-[2px] border border-neutral-600 px-1 leading-[14px] text-neutral-400">
                      REVIEW
                    </span>
                  )
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-neutral-800 px-3 py-1.5 ${MONO} text-[10px] text-neutral-600 [&>span]:whitespace-nowrap`}
        aria-label="Keyboard shortcuts"
      >
        <span>↑↓ J K select</span>
        <span>A ack</span>
        <span>U unack</span>
        <span>R resolve</span>
        <span>O reopen</span>
        <span>G plan</span>
        <span>C copy</span>
        <span>F full</span>
        <span>M map</span>
        <span>Shift+C call contact</span>
        <span>Shift+D delete</span>
      </div>
    </section>
  );
}

function RowTag({ children, tone }: { children: ReactNode; tone?: 'alert' }) {
  return (
    <span
      className={`shrink-0 rounded-[2px] border px-1 text-[9px] leading-[13px] tracking-[0.04em] uppercase ${MONO} ${
        tone === 'alert' ? 'border-red-500/70 text-red-300' : 'border-neutral-600 text-neutral-400'
      }`}
    >
      {children}
    </span>
  );
}
