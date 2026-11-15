'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Incident } from '@/types/incident';
import {
  MAX_SHOWN_BUILDINGS,
  buildingsInRange,
  estimateMovedEnough,
  resolveIncidentLocation,
  type IncidentLocation,
  type LocationConfidence,
  type LocationEstimate,
  type RankedBuilding,
} from './locationEstimate';
import { omitKeys } from './useResponsePlans';

type Stable = { estimate: LocationEstimate };

function assemble(
  estimate: LocationEstimate,
  buildings: RankedBuilding[],
  confirmed: RankedBuilding | null,
  backendBuildingName: string | null,
): IncidentLocation {
  const confidence: LocationConfidence = confirmed
    ? 'confirmed'
    : buildings.length === 0
      ? 'none'
      : buildings.length === 1
        ? 'single'
        : 'multiple';
  const shown = confirmed ? [confirmed] : buildings.slice(0, MAX_SHOWN_BUILDINGS);
  const moreCount = confirmed ? 0 : Math.max(0, buildings.length - MAX_SHOWN_BUILDINGS);
  const top = buildings[0]?.name ?? null;
  return {
    estimate,
    buildings,
    shown,
    moreCount,
    confidence,
    confirmed,
    backendBuildingName,
    topDiffersFromBackend: Boolean(backendBuildingName && top && backendBuildingName !== top && !confirmed),
  };
}

/**
 * Per-incident location resolution with anti-flicker stability and in-memory
 * "confirm building" overrides that survive polling refreshes.
 */
/**
 * @param nowMs Page clock from `useClock` (null during prerender). Avoids `Date.now()` in render.
 */
export function useIncidentLocations(incidents: Incident[], nowMs: number | null) {
  const [confirmedById, setConfirmedById] = useState<Record<string, string>>({});
  const stableRef = useRef(new Map<string, Stable>());

  const locations = useMemo(() => {
    // Prerender: a fixed epoch keeps estimates stable; live clock takes over after hydration.
    const now = nowMs ?? 0;
    const next = new Map<string, IncidentLocation>();
    const alive = new Set(incidents.map((i) => i._id));

    for (const id of [...stableRef.current.keys()]) {
      if (!alive.has(id)) stableRef.current.delete(id);
    }

    for (const incident of incidents) {
      const confirmedOsmId = confirmedById[incident._id];
      const fresh = resolveIncidentLocation(incident, confirmedOsmId, now);
      const prev = stableRef.current.get(incident._id);

      if (!fresh.estimate) {
        stableRef.current.delete(incident._id);
        next.set(incident._id, fresh);
        continue;
      }

      // Hold the previous centre/radius unless it moved enough — stops highlight flicker.
      const hold = prev && !confirmedOsmId && !estimateMovedEnough(prev.estimate, fresh.estimate);
      const estimate: LocationEstimate = hold
        ? {
            ...prev!.estimate,
            readingCount: fresh.estimate.readingCount,
            accuracyAssumed: fresh.estimate.accuracyAssumed || prev!.estimate.accuracyAssumed,
          }
        : fresh.estimate;

      if (!hold) stableRef.current.set(incident._id, { estimate: fresh.estimate });

      if (!hold && !confirmedOsmId) {
        next.set(incident._id, fresh);
        continue;
      }

      const buildings = buildingsInRange(estimate.lat, estimate.lng, estimate.radiusM);
      const confirmed =
        confirmedOsmId != null
          ? fresh.confirmed ?? buildings.find((b) => b.osmId === confirmedOsmId) ?? null
          : null;
      next.set(incident._id, assemble(estimate, buildings, confirmed, fresh.backendBuildingName));
    }
    return next;
  }, [incidents, confirmedById, nowMs]);

  const confirmBuilding = useCallback((incidentId: string, osmId: string) => {
    setConfirmedById((prev) => ({ ...prev, [incidentId]: osmId }));
  }, []);

  const clearConfirmed = useCallback((incidentId: string) => {
    setConfirmedById((prev) => {
      const { [incidentId]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
  }, []);

  /** Deleted incidents: drop their confirmed buildings. */
  const forget = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setConfirmedById((prev) => omitKeys(prev, gone));
  }, []);

  return { locations, confirmBuilding, clearConfirmed, forget };
}
