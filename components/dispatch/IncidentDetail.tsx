import type { ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import {
  STATUS_LONG,
  elapsed,
  estimateFloorRange,
  incidentNumber,
  tierStyle,
  typeLabel,
} from './severity';
import { SeveritySquare } from './SeveritySquare';
import { FOCUS_RING, LABEL, MONO } from './ui';

type Props = {
  incident: Incident | null;
  now: number | null;
  onAcknowledge: () => void;
  onResolve: () => void;
};

export function IncidentDetail({ incident, now, onAcknowledge, onResolve }: Props) {
  if (!incident) {
    return (
      <section className="flex min-h-0 items-center justify-center border-l border-neutral-800 text-neutral-600">
        No incident selected.
      </section>
    );
  }

  const t = tierStyle(incident.severityScore);
  const { building, iceProfile: ice } = incident;
  const canAck = incident.status === 'ACTIVE';
  const canResolve = incident.status !== 'RESOLVED';
  const floorRange = estimateFloorRange(incident);

  return (
    <section className="flex min-h-0 flex-col border-l border-neutral-800" aria-label="Incident detail">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <SeveritySquare score={incident.severityScore} size="lg" />
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-2 ${MONO} text-[12px] text-neutral-500`}>
            <span className="text-neutral-200">{incidentNumber(incident._id)}</span>
            <span>·</span>
            <span>{t.label.toUpperCase()} {incident.severityScore}/10</span>
          </div>
          <h2 className="truncate text-[15px] font-semibold text-neutral-50">{typeLabel(incident)}</h2>
        </div>
        <div className="text-right">
          <div className={`${MONO} text-[15px] text-neutral-100`}>{elapsed(incident.createdAt, now)}</div>
          <div className={LABEL}>{STATUS_LONG[incident.status]}</div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Recommended response">
          <p className="text-neutral-100">{t.response}</p>
        </Section>

        {(incident.crisisType === 'ACTIVE_THREAT' || incident.lowBandwidth) && (
          <div className="space-y-2 border-b border-neutral-800 px-4 py-3">
            {incident.crisisType === 'ACTIVE_THREAT' && (
              <Notice>Caller device in stealth mode. Do not call back.</Notice>
            )}
            {incident.lowBandwidth && (
              <Notice>
                Low-bandwidth SOS. No image or audio received; classification unavailable. GPS and
                medical profile only.
              </Notice>
            )}
          </div>
        )}

        <Section title="AI assessment">
          <Source label="Perception" source="Gemini">
            {incident.sceneSummary ?? <span className="text-neutral-600">No perception data.</span>}
          </Source>
          <Source label="Triage" source="Grok">
            {incident.dispatcherBrief}
          </Source>
        </Section>

        <Section title="Location">
          <Grid>
            <Row label="Building">{building?.name ?? 'Unknown location'}</Row>
            {building && <Row label="Type">{building.type}</Row>}
            {building && <Row label="Floors"><span className={MONO}>{building.floors}</span></Row>}
            {building?.notes && <Row label="Notes">{building.notes}</Row>}
            {floorRange && (
              <Row label="Est. floor">
                <span className={MONO}>
                  {floorRange[0] === floorRange[1] ? floorRange[0] : `${floorRange[0]}–${floorRange[1]}`}
                </span>{' '}
                <span className="text-neutral-500">(low confidence)</span>
              </Row>
            )}
            <Row label="Coords">
              <span className={MONO}>
                {incident.gps.lat.toFixed(5)}, {incident.gps.lng.toFixed(5)}
              </span>
            </Row>
            {incident.gps.accuracy !== undefined && (
              <Row label="GPS accuracy">
                <span className={MONO}>±{Math.round(incident.gps.accuracy)} m</span>
              </Row>
            )}
          </Grid>
        </Section>

        <Section title="Medical profile (ICE)">
          <Grid>
            <Row label="Name">
              {ice.name}
              {ice.age !== undefined && (
                <span className="ml-2 text-neutral-500">
                  age <span className={MONO}>{ice.age}</span>
                </span>
              )}
            </Row>
            <Row label="Conditions"><List items={ice.conditions} /></Row>
            <Row label="Allergies"><List items={ice.allergies} /></Row>
            <Row label="Medications"><List items={ice.medications} /></Row>
            <Row label="Contact">{ice.emergencyContact.name}</Row>
            <Row label="Phone"><span className={MONO}>{ice.emergencyContact.phone}</span></Row>
          </Grid>
        </Section>
      </div>

      <footer className="grid shrink-0 grid-cols-2 gap-2 border-t border-neutral-800 p-3">
        <ActionButton onClick={onAcknowledge} disabled={!canAck} shortcut="A">
          Acknowledge
        </ActionButton>
        <ActionButton onClick={onResolve} disabled={!canResolve} shortcut="R">
          Resolve
        </ActionButton>
      </footer>
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h3 className={`${LABEL} mb-2`}>{title}</h3>
      {children}
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[2px] border border-neutral-600 px-2.5 py-1.5 text-neutral-100">
      <span className={`${LABEL} mr-2 text-neutral-400`}>Notice</span>
      {children}
    </p>
  );
}

function Source({ label, source, children }: { label: string; source: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-0.5 text-[11px] text-neutral-500">
        {label} <span className={`${MONO} text-neutral-600`}>({source})</span>
      </div>
      <p className="text-neutral-200">{children}</p>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{children}</dd>
    </>
  );
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-neutral-600">None listed</span>;
  return <>{items.join(', ')}</>;
}

function ActionButton({
  onClick,
  disabled,
  shortcut,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  shortcut: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts={shortcut}
      className={`flex h-8 items-center justify-between rounded-[2px] border border-neutral-700 bg-neutral-900 px-3 text-neutral-100 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-600 ${FOCUS_RING}`}
    >
      <span>{children}</span>
      <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] text-neutral-500`}>{shortcut}</kbd>
    </button>
  );
}
