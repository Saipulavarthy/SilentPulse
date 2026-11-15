'use client';

import type { ReactNode } from 'react';
import type { DashIncident } from './normalize';
import { queueLocationLabel, type IncidentLocation } from './locationEstimate';
import { incidentNumber, locationLabel, tierStyle, typeLabel } from './severity';
import { SeveritySquare } from './SeveritySquare';
import { StatusActions, type StatusActionHandlers } from './StatusActions';
import { FOCUS_RING, LABEL, MONO } from './ui';
import type { PlanEntry } from './useResponsePlans';

/**
 * Full-screen map only. Translucent dark panels with a light blur and a soft shadow: the one
 * place in the dashboard where blur and shadow are used; the three-column console stays flat.
 */
const FLOAT =
  'pointer-events-auto rounded-[2px] border border-white/10 bg-[#0d0e10]/75 shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur-md';

function PanelHeader({ title, collapsed, onToggle }: { title: ReactNode; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 border-b border-white/10 px-3">
      <div className={`${LABEL} text-neutral-400`}>{title}</div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={`${MONO} rounded-[2px] px-1 text-[11px] text-neutral-400 hover:text-neutral-100 ${FOCUS_RING}`}
      >
        {collapsed ? 'Show' : 'Hide'}
      </button>
    </div>
  );
}

/** Compact queue: severity, id, type, location. */
export function FloatingQueue({
  incidents,
  title,
  selectedId,
  onSelect,
  collapsed,
  onToggle,
  locations,
}: {
  incidents: DashIncident[];
  title: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  locations?: Map<string, IncidentLocation>;
}) {
  return (
    <section aria-label="Incident queue (full screen)" className={`${FLOAT} absolute top-3 left-[132px] z-10 w-[330px]`}>
      <PanelHeader title={title} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <div role="listbox" aria-label="Incidents" className="max-h-[min(60vh,520px)] overflow-y-auto py-1">
          {incidents.length === 0 && <div className="px-3 py-3 text-neutral-500">No incidents in this view.</div>}
          {incidents.map((i) => {
            const selected = i._id === selectedId;
            return (
              <div
                key={i._id}
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(i._id)}
                className={`grid cursor-default grid-cols-[20px_64px_minmax(0,1fr)] items-center gap-x-2 border-l-[3px] px-2.5 py-1 ${tierStyle(i.severityScore).edge} ${
                  selected ? 'bg-sky-400/15 text-neutral-50' : 'hover:bg-white/5'
                }`}
              >
                <SeveritySquare score={i.severityScore} />
                <span className={`${MONO} text-[11px] text-neutral-400`}>{incidentNumber(i._id)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-neutral-100">
                    {typeLabel(i)}
                    {i.escalated && <span className="ml-1.5 text-[10px] text-red-300 uppercase">· signal lost</span>}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-400">
                    {locations?.get(i._id) ? queueLocationLabel(locations.get(i._id)!).text : locationLabel(i)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Condensed card for the selected incident. */
export function FloatingDetail({
  incident,
  plan,
  collapsed,
  onToggle,
  actions,
  location,
  contactLine,
}: {
  incident: DashIncident | null;
  plan: PlanEntry | undefined;
  collapsed: boolean;
  onToggle: () => void;
  actions: StatusActionHandlers;
  location?: IncidentLocation;
  /** Compact emergency-contact call status, e.g. "Alert call: Ringing". */
  contactLine?: string | null;
}) {
  return (
    <section aria-label="Selected incident (full screen)" className={`${FLOAT} absolute top-3 right-3 z-10 w-[340px]`}>
      <PanelHeader title={incident ? incidentNumber(incident._id) : 'No selection'} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && incident && (
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-3">
            <SeveritySquare score={incident.severityScore} size="lg" />
            <div className="min-w-0">
              <div className={`${MONO} text-[11px] text-neutral-400`}>
                {tierStyle(incident.severityScore).label.toUpperCase()} {incident.severityScore}/10
                {incident.escalated && <span className="ml-2 text-red-300">SIGNAL LOST</span>}
              </div>
              <div className="truncate text-[15px] font-semibold text-neutral-50">{typeLabel(incident)}</div>
              <div className="truncate text-[12px] text-neutral-300">
                {location ? queueLocationLabel(location).text : locationLabel(incident)}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-[11px] text-neutral-500">Radio brief</div>
            {plan?.status === 'ready' ? (
              <p className="text-[13px] leading-snug text-neutral-50">{plan.plan.radioBrief}</p>
            ) : plan?.status === 'loading' ? (
              <p className="text-[12px] text-neutral-500">Generating…</p>
            ) : plan?.status === 'error' ? (
              <p className="text-[12px] text-neutral-400">Plan failed: {plan.message}</p>
            ) : (
              <p className="text-[12px] text-neutral-500">
                No plan yet. Press <span className={MONO}>G</span> to generate.
              </p>
            )}
          </div>
          {contactLine && (
            <div className={`${MONO} text-[11px] text-neutral-300`} aria-label="Emergency contact call status">
              <span className="text-neutral-500">Contact · </span>
              {contactLine}
            </div>
          )}
          <StatusActions incident={incident} compact {...actions} />
        </div>
      )}
    </section>
  );
}
