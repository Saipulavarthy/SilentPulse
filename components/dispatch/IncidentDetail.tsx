import type { ReactNode } from 'react';
import type { Incident, Trend } from '@/types/incident';
import { CallerMessageSection } from './CallerMessageSection';
import type { DashIncident } from './normalize';
import { LocationSection } from './LocationSection';
import type { IncidentLocation } from './locationEstimate';
import { ResponsePlanSection, type CopyState } from './ResponsePlanSection';
import {
  STATUS_LONG,
  elapsed,
  estimateFloorRange,
  incidentNumber,
  tierStyle,
  typeLabel,
} from './severity';
import { SeveritySquare } from './SeveritySquare';
import { StatusActions, type StatusActionHandlers } from './StatusActions';
import { LABEL, MONO } from './ui';
import type { PlanEntry } from './useResponsePlans';

type Props = {
  incident: DashIncident | null;
  now: number | null;
  actions: StatusActionHandlers;
  plan: PlanEntry | undefined;
  onGeneratePlan: () => void;
  ticked: string[];
  onToggleTick: (action: string) => void;
  onCopyBrief: () => void;
  copyState: CopyState;
  onSendCallerMessage: (text: string) => void;
  onClearCallerMessage: () => void;
  location?: IncidentLocation;
  onConfirmBuilding: (osmId: string) => void;
  onClearConfirmedBuilding: () => void;
  onFlyToBuilding: (lng: number, lat: number) => void;
  /** The "Emergency contact" section (calls to the caller's emergency contact). */
  contactSection?: ReactNode;
};

const TREND_LABEL: Record<Trend, string> = { new: 'New', worsening: '▲ Worsening', stable: '▬ Stable', improving: '▼ Improving' };

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '—';
};

export function IncidentDetail({
  incident,
  now,
  actions,
  plan,
  onGeneratePlan,
  ticked,
  onToggleTick,
  onCopyBrief,
  copyState,
  onSendCallerMessage,
  onClearCallerMessage,
  location,
  onConfirmBuilding,
  onClearConfirmedBuilding,
  onFlyToBuilding,
  contactSection,
}: Props) {
  if (!incident) {
    return (
      <section className="flex min-h-0 items-center justify-center border-l border-neutral-800 text-neutral-600">
        No incident selected.
      </section>
    );
  }

  const t = tierStyle(incident.severityScore);
  const { iceProfile: ice, gps } = incident;
  const floorRange = estimateFloorRange(incident);
  const showFloorEstimate =
    floorRange && (location?.confidence === 'single' || location?.confidence === 'confirmed');

  return (
    <section className="flex min-h-0 flex-col border-l border-neutral-800" aria-label="Incident detail">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <SeveritySquare score={incident.severityScore} size="lg" />
        <div className="min-w-0 flex-1">
          <div className={`flex flex-wrap items-center gap-x-2 ${MONO} text-[12px] text-neutral-500`}>
            <span className="text-neutral-200">{incidentNumber(incident._id)}</span>
            <span>·</span>
            <span>
              {t.label.toUpperCase()} {incident.severityScore}/10
            </span>
            {incident.trend && <span className="text-neutral-300">{TREND_LABEL[incident.trend]}</span>}
            {incident.simulated && <Tag>Simulated</Tag>}
          </div>
          <h2 className="truncate text-[15px] font-semibold text-neutral-50">{typeLabel(incident)}</h2>
        </div>
        <div className="text-right">
          <div className={`${MONO} text-[15px] text-neutral-100`}>{elapsed(incident.createdAt, now)}</div>
          <div className={LABEL}>{STATUS_LONG[incident.status]}</div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {incident.escalated && (
          <div className="border-b border-neutral-800 bg-red-950/40 px-4 py-3" role="alert">
            <div className="text-[13px] font-semibold tracking-[0.08em] text-red-300">SIGNAL LOST</div>
            <p className="text-neutral-100">{incident.escalationReason ?? 'Live session stopped sending updates.'}</p>
            {incident.lastSeenAt && (
              <p className={`${MONO} text-[11px] text-neutral-400`}>Last seen {clock(incident.lastSeenAt)}</p>
            )}
          </div>
        )}

        {incident.userProvidedContext && (
          <div className="border-b border-neutral-800 px-4 py-2.5 text-[13px] text-neutral-200">
            <span className={`${LABEL} mr-2 text-neutral-400`}>Caller selected</span>
            {formatCallerContext(incident.userProvidedContext)}
          </div>
        )}

        <Section title="Recommended response">
          <p className="text-neutral-100">{t.response}</p>
        </Section>

        <CallerMessageSection
          incident={incident}
          onSend={onSendCallerMessage}
          onClear={onClearCallerMessage}
        />

        {contactSection}

        <ResponsePlanSection
          incident={incident}
          location={location}
          entry={plan}
          onGenerate={onGeneratePlan}
          now={now}
          ticked={ticked}
          onToggleTick={onToggleTick}
          onCopy={onCopyBrief}
          copyState={copyState}
        />

        {(incident.crisisType === 'ACTIVE_THREAT' || incident.lowBandwidth || incident.classificationFailed || incident.dataIssues.length > 0) && (
          <div className="space-y-2 border-b border-neutral-800 px-4 py-3">
            {incident.crisisType === 'ACTIVE_THREAT' && (
              <Notice>Caller device in stealth mode. Do not call back. Silent messages only.</Notice>
            )}
            {incident.classificationFailed && <Notice>AI classification failed. Treat as unverified.</Notice>}
            {incident.lowBandwidth && (
              <Notice>
                Low-bandwidth SOS. No image or audio received; classification unavailable. GPS and medical profile only.
              </Notice>
            )}
            {incident.dataIssues.length > 0 && (
              <Notice label="Data">
                {incident.dataIssues.join('. ')}.
              </Notice>
            )}
          </div>
        )}

        <Section title="AI assessment">
          <Source label="Perception" source="Gemini">
            {incident.sceneSummary ? (
              <p className="text-neutral-200">{incident.sceneSummary}</p>
            ) : (
              <p className="text-neutral-600">No perception summary</p>
            )}
            {incident.cues && incident.cues.length > 0 && (
              <ul className="mt-1 flex list-none flex-wrap gap-1 p-0">
                {incident.cues.map((c) => (
                  <li key={c} className="rounded-[2px] bg-neutral-800 px-1.5 py-0.5 text-[12px] text-neutral-200">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </Source>
          <Source label="Triage" source="Grok">
            <p className="text-neutral-200">{incident.dispatcherBrief}</p>
            {incident.reasons && incident.reasons.length > 0 && (
              <ul className="mt-1 list-none space-y-0.5 p-0">
                {incident.reasons.map((r) => (
                  <li key={r} className="border-l-2 border-neutral-700 pl-2 text-[12px] text-neutral-300">
                    {r}
                  </li>
                ))}
              </ul>
            )}
          </Source>
        </Section>

        <Section title="Location">
          <LocationSection
            location={location}
            fallbackBuildingName={incident.building?.name}
            gps={gps}
            onConfirm={onConfirmBuilding}
            onClearConfirm={onClearConfirmedBuilding}
            onFlyTo={onFlyToBuilding}
          />
          {showFloorEstimate && floorRange && (
            <div className="mt-1.5 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 text-[12px]">
              <span className={`${LABEL} text-neutral-500`}>Est. floor</span>
              <span className="text-neutral-200">
                <span className={MONO}>{floorRange[0] === floorRange[1] ? floorRange[0] : `${floorRange[0]}–${floorRange[1]}`}</span>{' '}
                <span className="text-neutral-500">(low confidence)</span>
              </span>
            </div>
          )}
        </Section>

        {incident.timeline && incident.timeline.length > 0 && (
          <Section title="Updates">
            <div className={`mb-1.5 ${MONO} text-[11px] text-neutral-500`}>
              {incident.updateCount ?? incident.timeline.length} updates
              {incident.lastSeenAt ? ` · last seen ${clock(incident.lastSeenAt)}` : ''}
            </div>
            <ol className="list-none space-y-1 p-0">
              {[...incident.timeline].reverse().map((u, i) => (
                <li key={`${u.ts}-${i}`} className="grid grid-cols-[58px_22px_minmax(0,1fr)] items-baseline gap-x-2 text-[12px]">
                  <span className={`${MONO} text-neutral-500`}>{clock(u.ts)}</span>
                  <SeveritySquare score={u.severityScore} />
                  <span className="min-w-0 text-neutral-300">
                    <span className="text-neutral-400">{u.lowBandwidth ? 'Low-bandwidth' : typeLabel({ ...incident, crisisType: u.crisisType, lowBandwidth: false })}</span>
                    {u.sceneSummary ? ` · ${u.sceneSummary}` : ''}
                    {u.classificationFailed ? ' · classification failed' : ''}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <Section title="Caller medical profile (ICE)">
          {ice ? <IceRows ice={ice} /> : <p className="text-neutral-500">No medical profile on file</p>}
        </Section>
      </div>

      <footer className="shrink-0 border-t border-neutral-800 p-3">
        <StatusActions incident={incident} {...actions} />
      </footer>
    </section>
  );
}

/** Only rows with a value; every field of the profile is optional. */
function IceRows({ ice }: { ice: NonNullable<Incident['iceProfile']> }) {
  const contact = ice.emergencyContact;
  const rows: [string, ReactNode][] = [];
  if (ice.name || ice.age !== undefined)
    rows.push([
      'Name',
      <>
        {ice.name ?? 'Unnamed'}
        {ice.age !== undefined && (
          <span className="ml-2 text-neutral-500">
            age <span className={MONO}>{ice.age}</span>
          </span>
        )}
      </>,
    ]);
  if (ice.bloodType) rows.push(['Blood type', <span key="b" className={MONO}>{ice.bloodType}</span>]);
  if (ice.conditions.length) rows.push(['Conditions', ice.conditions.join(', ')]);
  if (ice.allergies.length) rows.push(['Allergies', ice.allergies.join(', ')]);
  if (ice.medications?.length) rows.push(['Medications', ice.medications.join(', ')]);
  if (ice.mobilityNotes) rows.push(['Mobility', ice.mobilityNotes]);
  if (ice.sensoryNotes) rows.push(['Sensory', ice.sensoryNotes]);
  if (contact?.name || contact?.relation)
    rows.push(['Contact', [contact.name, contact.relation && `(${contact.relation})`].filter(Boolean).join(' ')]);
  if (contact?.phone) rows.push(['Phone', <span key="p" className={MONO}>{contact.phone}</span>]);
  if (rows.length === 0) return <p className="text-neutral-500">Profile on file but empty</p>;
  return (
    <Grid>
      {rows.map(([label, value]) => (
        <Row key={label} label={label}>
          {value}
        </Row>
      ))}
    </Grid>
  );
}

function formatCallerContext(context: string): string {
  if (context === 'NO_RESPONSE_RECEIVED') return 'No answer';
  if (context === 'USER_CANCELLED_SAFE') return "I'm safe — cancelled";
  return context;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h3 className={`${LABEL} mb-2`}>{title}</h3>
      {children}
    </section>
  );
}

function Notice({ children, label = 'Notice' }: { children: ReactNode; label?: string }) {
  return (
    <p className="rounded-[2px] border border-neutral-600 px-2.5 py-1.5 text-neutral-100">
      <span className={`${LABEL} mr-2 text-neutral-400`}>{label}</span>
      {children}
    </p>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className={`rounded-[2px] border border-neutral-600 px-1 text-[10px] tracking-[0.06em] text-neutral-300 uppercase ${MONO}`}>
      {children}
    </span>
  );
}

function Source({ label, source, children }: { label: string; source: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-0.5 text-[11px] text-neutral-500">
        {label} <span className={`${MONO} text-neutral-600`}>({source})</span>
      </div>
      {children}
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
