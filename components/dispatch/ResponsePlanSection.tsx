import type { ReactNode } from 'react';
import type { Incident } from '@/types/incident';
import type { PlanItem, PlanSource } from '@/types/responsePlan';
import { FOCUS_RING, LABEL, MONO } from './ui';
import { planBasis, type PlanEntry } from './useResponsePlans';

export type CopyState = 'copied' | 'failed' | null;

type Props = {
  incident: Incident;
  entry: PlanEntry | undefined;
  onGenerate: () => void;
  /** Page clock (ms), for the elapsed time while generating. */
  now: number | null;
  /** Action texts ticked for this incident. */
  ticked: string[];
  onToggleTick: (action: string) => void;
  onCopy: () => void;
  copyState: CopyState;
};

const SOURCE_LABEL: Record<PlanSource, string> = {
  buildingNotes: 'building',
  callerProfile: 'caller profile',
  callerDevice: 'caller device',
  perception: 'perception',
  triage: 'triage',
  timeline: 'timeline',
  otherCallers: 'other callers',
};

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function ResponsePlanSection({ incident, entry, onGenerate, now, ticked, onToggleTick, onCopy, copyState }: Props) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3" aria-label="Response plan" aria-busy={entry?.status === 'loading'}>
      <h3 className={`${LABEL} mb-2`}>Response plan</h3>
      {!entry && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-neutral-500">Draft notes from this incident&apos;s facts.</p>
          <PlanButton onClick={onGenerate} shortcut="G">
            Generate plan
          </PlanButton>
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
          <PlanButton onClick={onGenerate} shortcut="G">
            Retry
          </PlanButton>
        </div>
      )}
      {entry?.status === 'ready' && (
        <ReadyPlan
          incident={incident}
          entry={entry}
          onGenerate={onGenerate}
          ticked={ticked}
          onToggleTick={onToggleTick}
          onCopy={onCopy}
          copyState={copyState}
        />
      )}
    </section>
  );
}

function ReadyPlan({
  incident,
  entry,
  onGenerate,
  ticked,
  onToggleTick,
  onCopy,
  copyState,
}: {
  incident: Incident;
  entry: Extract<PlanEntry, { status: 'ready' }>;
  onGenerate: () => void;
  ticked: string[];
  onToggleTick: (action: string) => void;
  onCopy: () => void;
  copyState: CopyState;
}) {
  const { plan } = entry;
  const ai = entry.source === 'ai';
  const outOfDate = entry.basis !== planBasis(incident);

  return (
    <div className="space-y-3">
      <div className={`flex items-center justify-between gap-2 ${MONO} text-[11px] text-neutral-500`}>
        <span>
          {ai ? 'AI draft (Gemini) · verify before acting' : 'Rule-based (no AI)'}
          {entry.shortened ? ` · ${entry.shortened} shortened` : ''}
        </span>
        <span>{clock(entry.generatedAt)}</span>
      </div>
      {outOfDate && (
        <div className="flex items-center justify-between gap-3 rounded-[2px] border border-neutral-600 px-2.5 py-1.5">
          <span className="text-neutral-100">
            <span className={`${LABEL} mr-2 text-neutral-400`}>Out of date</span>
            Severity, type, cues, reasons, trend or signal changed since this plan.
          </span>
          <PlanButton onClick={onGenerate} shortcut="G">
            Regenerate
          </PlanButton>
        </div>
      )}

      <div className={`space-y-3 ${outOfDate ? 'opacity-50' : ''}`}>
        <div className="rounded-[2px] border border-neutral-800 bg-neutral-900/60 px-3 py-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] text-neutral-500">Radio brief</span>
            <PlanButton onClick={onCopy} shortcut="C" compact>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </PlanButton>
          </div>
          <p className="text-[14px] leading-snug text-neutral-50">{plan.radioBrief}</p>
        </div>

        {plan.situation && <p className={`${MONO} text-[11px] leading-snug text-neutral-400`}>{plan.situation}</p>}

        {!ai && entry.recommended && (
          <Block title="Recommended response">
            <p className="text-neutral-200">{entry.recommended}</p>
          </Block>
        )}

        {ai && (
          <Block title="Risks">
            {plan.risks.length ? (
              <ul className="list-none space-y-1 p-0">
                {plan.risks.map((r, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3">
                    <span className="text-neutral-200">{r.text}</span>
                    <SourceTag source={r.source} />
                  </li>
                ))}
              </ul>
            ) : (
              <None />
            )}
          </Block>
        )}

        {ai && (
          <Block title="Actions">
            {plan.actions.length ? (
              <ul className="list-none space-y-1 p-0">
                {plan.actions.map((a) => (
                  <Action key={a.text} item={a} done={ticked.includes(a.text)} onToggle={() => onToggleTick(a.text)} />
                ))}
              </ul>
            ) : (
              <None />
            )}
          </Block>
        )}

        {ai && plan.unknowns.length > 0 && (
          <Block title="Unknowns">
            <ul className="flex list-none flex-wrap gap-1.5 p-0">
              {plan.unknowns.map((q) => (
                <li key={q} className="rounded-[2px] border border-neutral-700 px-1.5 py-0.5 text-[12px] text-neutral-300">
                  {q}
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
    </div>
  );
}

function Action({ item, done, onToggle }: { item: PlanItem; done: boolean; onToggle: () => void }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <label className="flex cursor-pointer items-baseline gap-2">
        <input
          type="checkbox"
          checked={done}
          onChange={onToggle}
          className={`relative top-[2px] h-3.5 w-3.5 shrink-0 accent-sky-400 ${FOCUS_RING}`}
        />
        <span className={done ? 'text-neutral-500 line-through' : 'text-neutral-200'}>{item.text}</span>
      </label>
      <SourceTag source={item.source} />
    </li>
  );
}

function SourceTag({ source }: { source: PlanSource }) {
  return (
    <span className={`shrink-0 rounded-[2px] border border-neutral-700 px-1 text-[10px] whitespace-nowrap text-neutral-500 uppercase ${MONO}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

const None = () => <span className="text-neutral-600">Nothing specific in the input.</span>;

function Skeleton() {
  return (
    <div className="space-y-2" aria-label="Generating plan">
      {['w-3/4', 'w-full', 'w-5/6', 'w-2/3', 'w-4/5'].map((w) => (
        <div key={w} className={`h-3 ${w} rounded-[2px] bg-neutral-800 motion-safe:animate-pulse`} />
      ))}
    </div>
  );
}

function PlanButton({
  onClick,
  shortcut,
  compact = false,
  children,
}: {
  onClick: () => void;
  shortcut: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={shortcut}
      className={`flex shrink-0 items-center gap-2 rounded-[2px] border border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800 ${
        compact ? 'h-6 px-2 text-[12px]' : 'h-7 px-2.5'
      } ${FOCUS_RING}`}
    >
      {children}
      <kbd className={`${MONO} rounded-[2px] border border-current/30 px-1 text-[11px] text-neutral-500`}>{shortcut}</kbd>
    </button>
  );
}
