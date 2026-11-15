'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { awkwardIncidents } from '@/app/dispatch/awkwardIncidents';
import { mockIncidents } from '@/app/dispatch/mockIncidents';
import { statusToDispatcherStatus, type IncidentStatus } from '@/types/incident';
import { normalizeIncident, normalizeIncidents, type DashIncident } from './normalize';
import { incidentNumber } from './severity';

export type FeedMode = 'live' | 'mock';

export type FeedSync =
  | { state: 'starting' }
  | { state: 'mock' }
  | { state: 'connecting' }
  | { state: 'live'; lastSync: number }
  | { state: 'error'; lastSync: number | null; message: string };

const POLL_MS = 2000;
const ENDPOINT = '/api/incidents';

/**
 * `?mock=1` → mock data; anything else → live. Unknown (null) during the server render and
 * hydration, so nothing is fetched until the browser URL is known.
 */
function useMode(): FeedMode | null {
  return useSyncExternalStore(
    () => () => {},
    () => (new URLSearchParams(window.location.search).get('mock') === '1' ? 'mock' : 'live'),
    () => null,
  );
}

async function fetchIncidents(url: string): Promise<DashIncident[]> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`);
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.incidents)) throw new Error('Unexpected response: no incidents list');
  return normalizeIncidents(body.incidents);
}

const withStatus = (list: DashIncident[], id: string, status: IncidentStatus) =>
  list.map((i) => (i._id === id ? { ...i, status, dispatcherStatus: statusToDispatcherStatus(status), updatedAt: new Date().toISOString() } : i));

/**
 * The incident list for the dashboard.
 * - live: GET /api/incidents every 2 s (SWR). On failure the last good data stays and the sync
 *   state says so; it never falls back to mock data.
 * - mock (`?mock=1` only): the mock set plus the awkward set, normalized like live data.
 * `setStatus` updates optimistically, PATCHes the API, and rolls back with an error on failure.
 */
export function useIncidentFeed() {
  const mode = useMode();
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [mockList, setMockList] = useState<DashIncident[]>(() => normalizeIncidents([...mockIncidents, ...awkwardIncidents]));
  const [mutationError, setMutationError] = useState<string | null>(null);

  const swr = useSWR(mode === 'live' ? ENDPOINT : null, fetchIncidents, {
    refreshInterval: POLL_MS,
    keepPreviousData: true,
    revalidateOnFocus: true,
    dedupingInterval: 1000,
    onSuccess: () => setLastSync(Date.now()),
  });

  const incidents: DashIncident[] = mode === 'mock' ? mockList : (swr.data ?? []);

  const sync: FeedSync =
    mode === null
      ? { state: 'starting' }
      : mode === 'mock'
        ? { state: 'mock' }
        : swr.error
          ? { state: 'error', lastSync, message: swr.error instanceof Error ? swr.error.message : String(swr.error) }
          : lastSync === null
            ? { state: 'connecting' }
            : { state: 'live', lastSync };

  const { mutate } = swr;
  const setStatus = useCallback(
    async (id: string, status: IncidentStatus, verb?: string) => {
      setMutationError(null);
      if (mode === 'mock') {
        setMockList((list) => withStatus(list, id, status));
        return;
      }
      try {
        await mutate(
          async (current) => {
            const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            const updated = normalizeIncident(body);
            return (current ?? []).map((i) => (i._id === id ? (updated ?? i) : i));
          },
          {
            optimisticData: (current) => withStatus(current ?? [], id, status),
            rollbackOnError: true,
            populateCache: true,
            revalidate: false,
          },
        );
      } catch (e) {
        const action = verb ?? (status === 'ACKNOWLEDGED' ? 'acknowledge' : status === 'RESOLVED' ? 'resolve' : 'update');
        setMutationError(`Could not ${action} ${incidentNumber(id)}: ${e instanceof Error ? e.message : String(e)}. Change rolled back.`);
      }
    },
    [mode, mutate],
  );

  return { mode, incidents, sync, setStatus, mutationError, clearMutationError: () => setMutationError(null) };
}
