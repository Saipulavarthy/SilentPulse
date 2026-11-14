import type { ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import { FOCUS_RING, LABEL, MONO } from './ui';
import type { PlanEntry } from './useResponsePlans';

type Props = {
  incident: Incident;
  entry: PlanEntry | undefined;
  onGenerate: () => void;
  /** Page clock (ms), for the elapsed time while generating. */
  now: number | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function ResponsePlanSection({ incident, entry, onGenerate, now }: Props) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3" aria-label="Response plan" aria-busy={entry?.status === 'loading'}>
      <h3 className={`${LABEL} mb-2`}>Response plan</h3>
      {!entry && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-neutral-500">Draft a plan from this incident&apos;s facts.</p>
          <PlanButton onClick={onGenerate}>Generate plan</PlanButton>
        </div>
      )}
      {entry?.status === 'loading' && (
        <>
          <div className={`mb-2 flex justify-between ${MONO} text-[11px] text-neutral-500`} aria-live="off">
            <span>{entry.background ? 'Generating in background…' : 'Generating…'}</span>
            <span>{now === null ? '' : `${Math.max(0, Math.floor((now - entry.startedAt) / 1000))}s`}</span>
          </div>
          <Skeleton />
        </>
      )}
      {entry?.status === 'error' && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-neutral-300">
            <span className={`${LABEL} mr-2 text-neutral-400`}>Error</span>
            {entry.message}
          </p>
          <PlanButton onClick={onGenerate}>Retry</PlanButton>
        </div>
      )}
      {entry?.status === 'ready' && <ReadyPlan incident={incident} entry={entry} onGenerate={onGenerate} />}
    </section>
  );
}

function ReadyPlan({
  incident,
  entry,
  onGenerate,
}: {
  incident: Incident;
  entry: Extract<PlanEntry, { status: 'ready' }>;
  onGenerate: () => void;
}) {
  const { plan } = entry;
  const outOfDate =
    entry.basis.severityScore !== incident.severityScore || entry.basis.crisisType !== incident.crisisType;

  return (
    <div className="space-y-3">
      <div className={`flex items-center justify-between gap-2 ${MONO} text-[11px] text-neutral-500`}>
        <span>
          {entry.source === 'ai' ? 'AI draft (Gemini) · verify before acting' : 'Rule-based fallback (no AI)'}
          {entry.shortened ? ` · ${entry.shortened} item${entry.shortened === 1 ? '' : 's'} shortened` : ''}
        </span>
        <span>{clock(entry.generatedAt)}</span>
      </div>
      {outOfDate && (
        <div className="flex items-center justify-between gap-3 rounded-[2px] border border-neutral-600 px-2.5 py-1.5">
          <span className="text-neutral-100">
            <span className={`${LABEL} mr-2 text-neutral-400`}>Out of date</span>
            Severity or type changed since this plan.
          </span>
          <PlanButton onClick={onGenerate}>Regenerate</PlanButton>
        </div>
      )}

      <div className={outOfDate ? 'opacity-50' : undefined}>
        {plan.units.length > 0 && entry.source === 'fallback' ? (
          // Fallback: unit types only (no counts: it follows no real protocol), plus the tier's text.
          <div>
            <div className="mb-0.5 text-[11px] text-neutral-500">Unit types</div>
            <p className="text-neutral-100">{plan.units.map((u) => u.type).join(' · ')}</p>
            <p className="text-neutral-300">{plan.units[0].reason}</p>
          </div>
        ) : plan.units.length > 0 ? (
          <table className="w-full table-fixed text-left">
            <thead>
              <tr className={LABEL}>
                <th className="w-[64px] pb-1 font-medium">Unit</th>
                <th className="pb-1 pl-3 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {plan.units.map((u, i) => (
                <tr key={`${u.type}-${i}`} className="border-t border-neutral-900 align-top">
                  <td className="py-1 text-neutral-100">{u.type}</td>
                  <td className="py-1 pl-3 text-neutral-300">{u.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-neutral-300">No units: review before dispatch.</p>
        )}

        <PlanBlock title="Approach">
          <p className="text-neutral-200">{plan.approach}</p>
        </PlanBlock>
        <PlanList title="Equipment" items={plan.equipment} />
        <PlanList title="Cautions" items={plan.cautions} />
        <PlanBlock title="First actions">
          {plan.firstActions.length ? (
            <ol className="space-y-0.5">
              {plan.firstActions.map((a, i) => (
                <li key={i} className="flex gap-2 text-neutral-200">
                  <span className={`${MONO} text-neutral-500`}>{i + 1}.</span>
                  <span>{a}</span>
                </li>
              ))}
            </ol>
          ) : (
            <None />
          )}
        </PlanBlock>
        <PlanList title="Unknowns" items={plan.unknowns} />
      </div>
    </div>
  );
}

function PlanBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2.5">
      <div className="mb-0.5 text-[11px] text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  return (
    <PlanBlock title={title}>
      {items.length ? (
        <ul className="space-y-0.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-neutral-200">
              <span className="text-neutral-600">–</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <None />
      )}
    </PlanBlock>
  );
}

const None = () => <span className="text-neutral-600">None</span>;

function Skeleton() {
  return (
    <div className="space-y-2" aria-label="Generating plan">
      {['w-3/4', 'w-full', 'w-5/6', 'w-2/3', 'w-4/5'].map((w) => (
        <div key={w} className={`h-3 ${w} rounded-[2px] bg-neutral-800 motion-safe:animate-pulse`} />
      ))}
    </div>
  );
}

function PlanButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts="G"
      className={`flex h-7 shrink-0 items-center gap-2 rounded-[2px] border border-neutral-700 bg-neutral-900 px-2.5 text-neutral-100 hover:bg-neutral-800 ${FOCUS_RING}`}
    >
      {children}
      <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] text-neutral-500`}>G</kbd>
    </button>
  );
}
