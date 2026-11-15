'use client';

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
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

/** What a delete request covers. `resolved` and `all` delete server-side by status, not by id. */
export type DeleteScope = { kind: 'one'; id: string } | { kind: 'resolved' } | { kind: 'all' };

/** pending: DELETE in flight. done: server confirmed; dropped once a poll no longer returns it. */
type Tombstone = 'pending' | 'done';

function deleteUrl(scope: DeleteScope): string {
  if (scope.kind === 'one') return `${ENDPOINT}/${encodeURIComponent(scope.id)}`;
  return scope.kind === 'resolved' ? `${ENDPOINT}?status=RESOLVED` : `${ENDPOINT}?status=ALL&confirm=DELETE-ALL`;
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
  /** Deleted ids hidden from every view, so polls can't bring them back for a moment. */
  const [tombstones, setTombstones] = useState<ReadonlyMap<string, Tombstone>>(() => new Map());

  const swr = useSWR(mode === 'live' ? ENDPOINT : null, fetchIncidents, {
    refreshInterval: POLL_MS,
    keepPreviousData: true,
    revalidateOnFocus: true,
    dedupingInterval: 1000,
    onSuccess: (data) => {
      setLastSync(Date.now());
      // A poll without a confirmed-deleted id proves it is gone: stop ignoring it.
      setTombstones((prev) => {
        if (prev.size === 0) return prev;
        const present = new Set(data.map((i) => i._id));
        const next = new Map(prev);
        for (const [id, state] of prev) if (state === 'done' && !present.has(id)) next.delete(id);
        return next.size === prev.size ? prev : next;
      });
    },
  });

  const source = mode === 'mock' ? mockList : swr.data;
  const incidents: DashIncident[] = useMemo(
    () => (source ?? []).filter((i) => !tombstones.has(i._id)),
    [source, tombstones],
  );

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
    async (id: string, status: IncidentStatus, verb?: string): Promise<boolean> => {
      setMutationError(null);
      if (mode === 'mock') {
        setMockList((list) => withStatus(list, id, status));
        return true;
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
        return true;
      } catch (e) {
        const action = verb ?? (status === 'ACKNOWLEDGED' ? 'acknowledge' : status === 'RESOLVED' ? 'resolve' : 'update');
        setMutationError(`Could not ${action} ${incidentNumber(id)}: ${e instanceof Error ? e.message : String(e)}. Change rolled back.`);
        return false;
      }
    },
    [mode, mutate],
  );

  /** Send (non-empty) or clear (empty string) the live dispatcher → caller message. */
  const setDispatcherMessage = useCallback(
    async (id: string, text: string) => {
      setMutationError(null);
      if (mode === 'mock') {
        const now = new Date().toISOString();
        setMockList((list) =>
          list.map((i) => {
            if (i._id !== id) return i;
            if (!text.trim()) {
              const { dispatcherMessage: _removed, ...rest } = i;
              void _removed;
              return rest;
            }
            return {
              ...i,
              dispatcherMessage: { text: text.trim(), sentAt: now },
              updatedAt: now,
            };
          }),
        );
        return;
      }
      try {
        await mutate(
          async (current) => {
            const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dispatcherMessage: text }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            const updated = normalizeIncident(body);
            return (current ?? []).map((i) => (i._id === id ? (updated ?? i) : i));
          },
          { populateCache: true, revalidate: false },
        );
      } catch (e) {
        setMutationError(
          `Could not message ${incidentNumber(id)}: ${e instanceof Error ? e.message : String(e)}.`,
        );
      }
    },
    [mode, mutate],
  );

  /**
   * Permanently deletes `ids` (the incidents the scope covers, as currently shown). They vanish
   * at once; on failure they come back and an error is shown. Resolves to the removed ids, or
   * null on failure. Mock mode: in memory only, no request.
   */
  const deleteIncidents = useCallback(
    async (scope: DeleteScope, ids: string[]): Promise<string[] | null> => {
      setMutationError(null);
      const gone = new Set(ids);
      if (mode === 'mock') {
        setMockList((list) => list.filter((i) => !gone.has(i._id)));
        return ids;
      }
      const mark = (state: Tombstone | null) =>
        setTombstones((prev) => {
          const next = new Map(prev);
          for (const id of ids) {
            if (state) next.set(id, state);
            else next.delete(id);
          }
          return next;
        });
      mark('pending');
      try {
        const res = await fetch(deleteUrl(scope), { method: 'DELETE' });
        const body = await res.json().catch(() => null);
        // 404 on a single delete: already gone, which is what was asked for.
        if (!res.ok && !(scope.kind === 'one' && res.status === 404)) throw new Error(body?.error ?? `HTTP ${res.status}`);
        // Drop them from the cache too. This mutation also makes SWR discard any poll that
        // started before it, so a stale response can't resurrect them.
        await mutate((current) => (current ?? []).filter((i) => !gone.has(i._id)), { revalidate: false });
        mark('done');
        return ids;
      } catch (e) {
        mark(null);
        const what =
          scope.kind === 'one' ? incidentNumber(scope.id) : scope.kind === 'resolved' ? `${ids.length} resolved incidents` : 'all incidents';
        setMutationError(`Could not delete ${what}: ${e instanceof Error ? e.message : String(e)}. Restored.`);
        return null;
      }
    },
    [mode, mutate],
  );

  return {
    mode,
    incidents,
    sync,
    setStatus,
    setDispatcherMessage,
    deleteIncidents,
    mutationError,
    clearMutationError: () => setMutationError(null),
  };
}
