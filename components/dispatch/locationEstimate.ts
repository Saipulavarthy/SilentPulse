// Location estimate from GPS + timeline, and which campus buildings fall in the
// uncertainty circle. Pure helpers — no React. Used by the map, queue, detail and plans.

import { LANDMARKS, type Landmark } from '@/lib/landmarks';
import type { Incident } from '@/types/incident';

const M_PER_LAT = 111_320;
const mPerLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Assumed horizontal accuracy when the device omitted it. */
export const ASSUMED_ACCURACY_M = 30;
/** Drop older readings once something newer than this exists. */
const STALE_MS = 3 * 60_000;
/** Map / list only colour this many buildings; the rest become "+N more". */
export const MAX_SHOWN_BUILDINGS = 6;
/** Stable estimate: ignore centre moves smaller than this. */
export const STABLE_MOVE_M = 5;
/** Stable estimate: ignore radius changes smaller than this fraction. */
export const STABLE_RADIUS_FRAC = 0.2;

export type LocationEstimate = {
  lat: number;
  lng: number;
  /** Uncertainty radius in metres. */
  radiusM: number;
  /** True when at least one used reading lacked device accuracy. */
  accuracyAssumed: boolean;
  readingCount: number;
};

export type LocationConfidence = 'single' | 'multiple' | 'none' | 'confirmed';

export type RankedBuilding = {
  name: string;
  osmId: string;
  lat: number;
  lng: number;
  levels: number | null;
  /** Fraction of the uncertainty circle that overlaps this footprint (0–1). */
  overlap: number;
  /** Metres from estimate centre to nearest outline point (0 if centre is inside). */
  distanceM: number;
  floors: number;
  type: string;
  notes?: string;
};

export type IncidentLocation = {
  estimate: LocationEstimate | null;
  /** All buildings intersecting the circle, best overlap first. */
  buildings: RankedBuilding[];
  /** Buildings coloured on the map (≤ MAX_SHOWN_BUILDINGS). */
  shown: RankedBuilding[];
  moreCount: number;
  confidence: LocationConfidence;
  /** Dispatcher override, when set. */
  confirmed: RankedBuilding | null;
  /** Backend `incident.building.name`, if any. */
  backendBuildingName: string | null;
  /** Backend name differs from our top-ranked estimate. */
  topDiffersFromBackend: boolean;
};

type Reading = { lat: number; lng: number; accuracy: number; assumed: boolean; ts: number };

function readingsOf(incident: Incident, now = Date.now()): Reading[] {
  const out: Reading[] = [];
  const push = (lat: number, lng: number, accuracy: number | undefined, ts: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const assumed = !(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > 0);
    out.push({
      lat,
      lng,
      accuracy: assumed ? ASSUMED_ACCURACY_M : accuracy!,
      assumed,
      ts: Number.isFinite(ts) ? ts : now,
    });
  };

  if (incident.gps) {
    const ts = Date.parse(incident.lastSeenAt ?? incident.updatedAt ?? incident.createdAt);
    push(incident.gps.lat, incident.gps.lng, incident.gps.accuracy, ts);
  }
  for (const e of incident.timeline ?? []) {
    if (!e.gps) continue;
    push(e.gps.lat, e.gps.lng, undefined, Date.parse(e.ts));
  }
  if (out.length === 0) return [];

  const newest = Math.max(...out.map((r) => r.ts));
  const hasFresh = out.some((r) => newest - r.ts <= STALE_MS);
  return hasFresh ? out.filter((r) => newest - r.ts <= STALE_MS) : out;
}

/**
 * Weighted centre + radius from current GPS and recent timeline points.
 * Newer and more accurate readings weigh more.
 */
export function estimateLocation(incident: Incident, now = Date.now()): LocationEstimate | null {
  const readings = readingsOf(incident, now);
  if (readings.length === 0) return null;

  const newest = Math.max(...readings.map((r) => r.ts));
  let wLat = 0;
  let wLng = 0;
  let wRad = 0;
  let wSum = 0;
  let assumed = false;
  for (const r of readings) {
    const ageMin = Math.max(0, (newest - r.ts) / 60_000);
    const recency = 1 / (1 + ageMin); // 1 when fresh, decays with minutes
    const precision = 1 / Math.max(r.accuracy, 1);
    const w = recency * precision;
    wLat += r.lat * w;
    wLng += r.lng * w;
    wRad += r.accuracy * w;
    wSum += w;
    if (r.assumed) assumed = true;
  }
  if (wSum <= 0) return null;
  return {
    lat: wLat / wSum,
    lng: wLng / wSum,
    radiusM: Math.max(1, wRad / wSum),
    accuracyAssumed: assumed,
    readingCount: readings.length,
  };
}

function inRing([x, y]: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygons = (p: [number, number], polygons: Landmark['polygons']) =>
  polygons.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));

function pointSegmentM(p: number[], a: number[], b: number[]): number {
  const k = mPerLng(p[1]);
  const [px, py, ax, ay, bx, by] = [p[0] * k, p[1] * M_PER_LAT, a[0] * k, a[1] * M_PER_LAT, b[0] * k, b[1] * M_PER_LAT];
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Metres from centre to the nearest outline vertex/edge; 0 if the centre is inside. */
export function distanceToLandmarkM(lat: number, lng: number, landmark: Landmark): number {
  if (inPolygons([lng, lat], landmark.polygons)) return 0;
  let best = Infinity;
  for (const poly of landmark.polygons) {
    const ring = poly[0];
    for (let i = 0; i < ring.length - 1; i++) {
      best = Math.min(best, pointSegmentM([lng, lat], ring[i], ring[i + 1]));
    }
  }
  return best;
}

/**
 * Fraction of the uncertainty circle that overlaps a building footprint.
 * Approximated by sampling the disk (deterministic polar grid).
 */
export function circleOverlapFraction(
  lat: number,
  lng: number,
  radiusM: number,
  landmark: Landmark,
  rings = 4,
  perRing = 24,
): number {
  const kLng = mPerLng(lat);
  const dLat = radiusM / M_PER_LAT;
  const dLng = radiusM / kLng;
  // Cheap bbox reject against the landmark's outer rings.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of landmark.polygons) {
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < lng - dLng || minX > lng + dLng || maxY < lat - dLat || minY > lat + dLat) return 0;

  let hit = 0;
  let total = 0;
  // Centre sample.
  total += 1;
  if (inPolygons([lng, lat], landmark.polygons)) hit += 1;
  for (let r = 1; r <= rings; r++) {
    const fr = r / rings;
    for (let k = 0; k < perRing; k++) {
      const a = (k / perRing) * 2 * Math.PI;
      const plat = lat + dLat * fr * Math.sin(a);
      const plng = lng + dLng * fr * Math.cos(a);
      total += 1;
      if (inPolygons([plng, plat], landmark.polygons)) hit += 1;
    }
  }
  // Also count any outline vertex inside the circle as a soft hit for skinny corners.
  for (const poly of landmark.polygons) {
    for (const [x, y] of poly[0]) {
      const dx = (x - lng) * kLng;
      const dy = (y - lat) * M_PER_LAT;
      if (Math.hypot(dx, dy) <= radiusM) {
        // Don't inflate total — just ensure overlap > 0 when a corner clips the circle.
        if (hit === 0) hit = 1;
        break;
      }
    }
  }
  return hit / total;
}

function toRanked(landmark: Landmark, overlap: number, distanceM: number): RankedBuilding {
  return {
    name: landmark.name,
    osmId: landmark.osmId,
    lat: landmark.lat,
    lng: landmark.lng,
    levels: landmark.levels,
    overlap,
    distanceM,
    floors: landmark.levels && landmark.levels > 0 ? landmark.levels : 0,
    type: 'Building',
  };
}

/** Every campus footprint that intersects the uncertainty circle, ranked by overlap then distance. */
export function buildingsInRange(lat: number, lng: number, radiusM: number): RankedBuilding[] {
  const ranked: RankedBuilding[] = [];
  for (const landmark of LANDMARKS) {
    const overlap = circleOverlapFraction(lat, lng, radiusM, landmark);
    if (overlap <= 0) continue;
    ranked.push(toRanked(landmark, overlap, distanceToLandmarkM(lat, lng, landmark)));
  }
  return ranked.sort((a, b) => b.overlap - a.overlap || a.distanceM - b.distanceM || a.name.localeCompare(b.name));
}

/** Whether a new estimate should replace a displayed one (anti-flicker). */
export function estimateMovedEnough(prev: LocationEstimate, next: LocationEstimate): boolean {
  const k = mPerLng(prev.lat);
  const dist = Math.hypot((next.lng - prev.lng) * k, (next.lat - prev.lat) * M_PER_LAT);
  if (dist > STABLE_MOVE_M) return true;
  const denom = Math.max(prev.radiusM, 1);
  return Math.abs(next.radiusM - prev.radiusM) / denom > STABLE_RADIUS_FRAC;
}

export function resolveIncidentLocation(
  incident: Incident,
  confirmedOsmId: string | null | undefined,
  now = Date.now(),
): IncidentLocation {
  const estimate = estimateLocation(incident, now);
  const backendBuildingName = incident.building?.name ?? null;
  if (!estimate) {
    return {
      estimate: null,
      buildings: [],
      shown: [],
      moreCount: 0,
      confidence: confirmedOsmId ? 'confirmed' : 'none',
      confirmed: null,
      backendBuildingName,
      topDiffersFromBackend: false,
    };
  }

  const buildings = buildingsInRange(estimate.lat, estimate.lng, estimate.radiusM);
  const confirmed =
    confirmedOsmId != null
      ? buildings.find((b) => b.osmId === confirmedOsmId) ??
        (() => {
          const lm = LANDMARKS.find((l) => l.osmId === confirmedOsmId);
          return lm ? toRanked(lm, 1, distanceToLandmarkM(estimate.lat, estimate.lng, lm)) : null;
        })()
      : null;

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
  const topDiffersFromBackend = Boolean(backendBuildingName && top && backendBuildingName !== top && !confirmed);

  return {
    estimate,
    buildings,
    shown,
    moreCount,
    confidence,
    confirmed,
    backendBuildingName,
    topDiffersFromBackend,
  };
}

/** Search all campus landmarks by name substring (confirm-building picker). */
export function searchCampusBuildings(query: string, limit = 12): RankedBuilding[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return LANDMARKS.filter((l) => l.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((l) => toRanked(l, 0, 0));
}

export function formatAccuracy(estimate: LocationEstimate): string {
  const n = Math.round(estimate.radiusM);
  return estimate.accuracyAssumed ? `±${n} m (assumed)` : `±${n} m`;
}

export function queueLocationLabel(loc: IncidentLocation): { text: string; title: string } {
  if (loc.confidence === 'confirmed' && loc.confirmed) {
    return { text: loc.confirmed.name, title: `${loc.confirmed.name} (confirmed)` };
  }
  if (loc.confidence === 'none' || loc.buildings.length === 0) {
    return { text: 'Outdoors / no building', title: 'No campus building in the GPS uncertainty circle' };
  }
  if (loc.confidence === 'single') {
    return { text: loc.buildings[0].name, title: loc.buildings[0].name };
  }
  const top = loc.buildings[0];
  const rest = loc.buildings.length - 1;
  const full = loc.buildings.map((b) => b.name).join(', ');
  return { text: `${top.name} +${rest}`, title: full };
}
