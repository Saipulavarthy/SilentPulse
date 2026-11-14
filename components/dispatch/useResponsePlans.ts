'use client';

import { useCallback, useRef, useState } from 'react';
import { landmarkAt } from '@/lib/landmarks';
import { ruleBasedPlan } from '@/lib/responsePlan';
import type { Incident } from '@/types/incident';
import type { OtherCaller, PlanBuilding, PlanIncident, PlanResponse, ResponsePlan } from '@/types/responsePlan';
import { tierStyle } from './severity';

export type PlanEntry =
  | { status: 'loading'; startedAt: number; background: boolean }
  | {
      status: 'ready';
      plan: ResponsePlan;
      source: 'ai' | 'fallback';
      model?: string;
      generatedAt: string;
      /** AI plans only: items the server cut to the word limit. */
      shortened?: number;
      /** Fallback only: the tier's recommended response. */
      recommended?: string;
      /** What the plan was generated from (see planBasis), to detect when it goes out of date. */
      basis: string;
    }
  | { status: 'error'; message: string };

/** Severity at or above which plans are generated in the background. */
export const PREFETCH_MIN_SEVERITY = 7;

type Context = { building: PlanBuilding | null; otherCallers: OtherCaller[] };
type Job = { incident: PlanIncident; context: Context; attempt: number };

/** Background regeneration key: severity, type and signal loss (not every new cue or reason). */
const basisKey = (i: Pick<Incident, 'severityScore' | 'crisisType' | 'escalated'>) =>
  `${i.severityScore}|${i.crisisType}|${i.escalated ? 'lost' : ''}`;

/** Everything the plan was drawn from: a change in any of it marks the plan out of date. */
export function planBasis(i: Pick<Incident, 'severityScore' | 'crisisType' | 'escalated' | 'trend' | 'cues' | 'reasons'>): string {
  return JSON.stringify([i.severityScore, i.crisisType, Boolean(i.escalated), i.trend ?? null, i.cues ?? [], i.reasons ?? []]);
}

/**
 * `?mock=1`: plans use the rule-based fallback and never call the API. Read when a request
 * starts, not during render: during hydration a render-time read is still false, and the
 * first background prefetch runs right after it.
 */
const isMockMode = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mock') === '1';

/** The building and the other open incidents in it (matched by building name). */
export function planContext(incident: Incident, all: Incident[]): Context {
  const b = incident.building;
  // Backend building first; otherwise the OSM name at the GPS point (name only).
  const osm = !b && incident.gps ? landmarkAt(incident.gps.lng, incident.gps.lat) : undefined;
  return {
    building: b
      ? { name: b.name, type: b.type, floors: b.floors, notes: b.notes }
      : osm
        ? { name: osm.name, type: 'Building', floors: osm.levels ?? 0 }
        : null,
    otherCallers: b
      ? all
          .filter((i) => i._id !== incident._id && i.status !== 'RESOLVED' && i.building?.name === b.name)
          .map((i) => ({
            crisisType: i.crisisType,
            severityScore: i.severityScore,
            status: i.status,
            createdAt: i.createdAt,
            summary: i.sceneSummary ?? i.dispatcherBrief,
          }))
      : [],
  };
}

/**
 * Response plans and action tick state, kept in memory per incident id. Both live outside the
 * incident list, so polling refreshes that replace incidents don't reset them.
 * - `generate`: on demand (button or G), any severity.
 * - `prefetch`: background generation for severity ≥ 7 incidents when they first appear or
 *   their severity / crisis type changes. One request at a time, highest severity first, at
 *   most one automatic retry. Never call it from inside the polling fetch itself.
 */
export function useResponsePlans() {
  const [plans, setPlans] = useState<Record<string, PlanEntry>>({});
  /** incident id → texts of ticked actions (by text, so a regenerated plan keeps matching ticks). */
  const [ticks, setTicks] = useState<Record<string, string[]>>({});
  const inFlight = useRef(new Set<string>());
  /** Basis (severity|type) each incident was last generated or queued for. */
  const handled = useRef(new Map<string, string>());
  const queue = useRef<Job[]>([]);
  const pumping = useRef(false);

  /** One generation. Resolves to whether it may be worth one automatic retry. */
  const run = useCallback(
    async (incident: PlanIncident, { building, otherCallers }: Context, background: boolean): Promise<'done' | 'retryable'> => {
      const id = incident._id;
      if (inFlight.current.has(id)) return 'done';
      handled.current.set(id, basisKey(incident));
      const set = (entry: PlanEntry) => setPlans((prev) => ({ ...prev, [id]: entry }));
      const basis = planBasis(incident);
      const fallback = (): PlanEntry => ({
        status: 'ready',
        plan: ruleBasedPlan(incident, building, otherCallers),
        source: 'fallback',
        recommended: tierStyle(incident.severityScore).response,
        generatedAt: new Date().toISOString(),
        basis,
      });

      if (isMockMode()) {
        set(fallback());
        return 'done';
      }

      inFlight.current.add(id);
      set({ status: 'loading', startedAt: Date.now(), background });
      try {
        const res = await fetch('/api/response-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ incident, building, otherCallers }),
        });
        const body = (await res.json()) as PlanResponse;
        if (body.ok) {
          set({ status: 'ready', plan: body.plan, source: 'ai', model: body.model, generatedAt: body.generatedAt, shortened: body.shortened, basis });
          return 'done';
        }
        if (body.error === 'missing_key') {
          set(fallback());
          return 'done';
        }
        set({ status: 'error', message: body.message });
        // Retrying into a quota wall or with a bad request won't help.
        return body.error === 'rate_limited' || body.error === 'bad_request' ? 'done' : 'retryable';
      } catch {
        set({ status: 'error', message: 'Could not reach the response-plan service.' });
        return 'retryable';
      } finally {
        inFlight.current.delete(id);
      }
    },
    [],
  );

  const generate = useCallback(
    (incident: PlanIncident, context: Context) => void run(incident, context, false),
    [run],
  );

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length) {
        queue.current.sort(
          (a, b) => b.incident.severityScore - a.incident.severityScore || Date.parse(b.incident.createdAt) - Date.parse(a.incident.createdAt),
        );
        const job = queue.current.shift()!;
        // Skip if superseded (generated on demand meanwhile, or basis changed and re-queued).
        if (job.attempt === 0 && handled.current.get(job.incident._id) !== `queued:${basisKey(job.incident)}`) continue;
        const outcome = await run(job.incident, job.context, true);
        if (outcome === 'retryable' && job.attempt === 0) queue.current.push({ ...job, attempt: 1 });
      }
    } finally {
      pumping.current = false;
    }
  }, [run]);

  /** Queues background plans for severity ≥ 7 incidents that are new or changed since last time. */
  const prefetch = useCallback(
    (incidents: Incident[]) => {
      let added = false;
      for (const incident of incidents) {
        if (incident.severityScore < PREFETCH_MIN_SEVERITY || incident.status === 'RESOLVED') continue;
        const key = basisKey(incident);
        const prev = handled.current.get(incident._id);
        if (prev === key || prev === `queued:${key}`) continue;
        handled.current.set(incident._id, `queued:${key}`);
        queue.current = queue.current.filter((j) => j.incident._id !== incident._id);
        queue.current.push({ incident, context: planContext(incident, incidents), attempt: 0 });
        added = true;
      }
      if (added) void pump();
    },
    [pump],
  );

  const toggleTick = useCallback((incidentId: string, action: string) => {
    setTicks((prev) => {
      const current = prev[incidentId] ?? [];
      const next = current.includes(action) ? current.filter((a) => a !== action) : [...current, action];
      return { ...prev, [incidentId]: next };
    });
  }, []);

  return { plans, generate, prefetch, ticks, toggleTick };
}
