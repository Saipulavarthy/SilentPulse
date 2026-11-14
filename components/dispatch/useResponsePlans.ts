'use client';

import { useCallback, useRef, useState } from 'react';
import { ruleBasedPlan } from '@/lib/responsePlan';
import type { CrisisType, Incident } from '@/types/incident';
import type { PlanBuilding, PlanIncident, PlanResponse, ResponsePlan } from '@/types/responsePlan';
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
      /** What the plan was generated from, to detect when it goes out of date. */
      basis: { severityScore: number; crisisType: CrisisType };
    }
  | { status: 'error'; message: string };

/** Severity at or above which plans are generated in the background. */
export const PREFETCH_MIN_SEVERITY = 7;

type Context = { building: PlanBuilding | null; otherOpenInBuilding: number };
type Job = { incident: PlanIncident; context: Context; attempt: number };

const basisKey = (i: Pick<Incident, 'severityScore' | 'crisisType'>) => `${i.severityScore}|${i.crisisType}`;

/** The building and the count of other open incidents in it (matched by building name). */
export function planContext(incident: Incident, all: Incident[]): Context {
  const b = incident.building;
  return {
    building: b ? { name: b.name, type: b.type, floors: b.floors, notes: b.notes } : null,
    otherOpenInBuilding: b
      ? all.filter((i) => i._id !== incident._id && i.status !== 'RESOLVED' && i.building?.name === b.name).length
      : 0,
  };
}

/**
 * Response plans kept in memory per incident id.
 * - `generate`: on demand (button or G), any severity.
 * - `prefetch`: background generation for severity ≥ 7 incidents when they first appear or
 *   their severity / crisis type changes. One request at a time, highest severity first, at
 *   most one automatic retry. Never call it from inside the polling fetch itself.
 */
export function useResponsePlans(mock: boolean) {
  const [plans, setPlans] = useState<Record<string, PlanEntry>>({});
  const inFlight = useRef(new Set<string>());
  /** Basis (severity|type) each incident was last generated or queued for. */
  const handled = useRef(new Map<string, string>());
  const queue = useRef<Job[]>([]);
  const pumping = useRef(false);

  /** One generation. Resolves to whether it may be worth one automatic retry. */
  const run = useCallback(
    async (incident: PlanIncident, { building, otherOpenInBuilding }: Context, background: boolean): Promise<'done' | 'retryable'> => {
      const id = incident._id;
      if (inFlight.current.has(id)) return 'done';
      handled.current.set(id, basisKey(incident));
      const set = (entry: PlanEntry) => setPlans((prev) => ({ ...prev, [id]: entry }));
      const basis = { severityScore: incident.severityScore, crisisType: incident.crisisType };
      const fallback = (): PlanEntry => ({
        status: 'ready',
        plan: ruleBasedPlan(incident, building, otherOpenInBuilding, tierStyle(incident.severityScore).response),
        source: 'fallback',
        generatedAt: new Date().toISOString(),
        basis,
      });

      if (mock) {
        set(fallback());
        return 'done';
      }

      inFlight.current.add(id);
      set({ status: 'loading', startedAt: Date.now(), background });
      try {
        const res = await fetch('/api/response-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ incident, building, otherOpenInBuilding }),
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
    [mock],
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

  return { plans, generate, prefetch };
}
