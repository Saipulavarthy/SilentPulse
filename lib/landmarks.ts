// Named UMass Amherst buildings with their OSM outlines, from data/umassBuildings.json
// (scripts/fetch-umass-buildings.mjs), plus hand-written data/umassBuildingOverrides.json.
// Bundled at build time; nothing is fetched at runtime.
// Data © OpenStreetMap contributors, ODbL 1.0.

import buildingData from '@/data/umassBuildings.json';
import overrideData from '@/data/umassBuildingOverrides.json';

type Ring = number[][];
/** GeoJSON-style MultiPolygon coordinates: polygons of [outer ring, ...holes], [lng, lat]. */
type Polygons = Ring[][];

export type Landmark = {
  name: string;
  /** Which tag gave the name, or the OSM feature inside the building it came from. */
  nameSource: string;
  osmId: string;
  lat: number;
  lng: number;
  /** OSM building:levels, when tagged. */
  levels: number | null;
  height: number | null;
  polygons: Polygons;
};

type Override = { name: string; osmId?: string; lat?: number; lng?: number };

const OVERRIDES = overrideData.overrides as Override[];
const byOsmId = new Map(OVERRIDES.filter((o) => o.osmId).map((o) => [o.osmId!, o.name]));
const byPoint = OVERRIDES.filter((o) => o.lat !== undefined && o.lng !== undefined);

/** All named buildings, with OSM-id overrides already applied. */
export const LANDMARKS: readonly Landmark[] = (buildingData.buildings as Landmark[]).map((l) =>
  byOsmId.has(l.osmId) ? { ...l, name: byOsmId.get(l.osmId)!, nameSource: 'override' } : l,
);

// ---- geometry -------------------------------------------------------------------------------

const M_PER_LAT = 111_320;
const mPerLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygons = (p: [number, number], polygons: Polygons) =>
  polygons.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));

type Indexed = { landmark: Landmark; bbox: [number, number, number, number]; areaDeg: number };

const INDEX: Indexed[] = LANDMARKS.map((landmark) => {
  const pts = landmark.polygons.flatMap((p) => p[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const bbox: Indexed['bbox'] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { landmark, bbox, areaDeg: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) };
});

/** Distance in metres from point p to segment ab (all [lng, lat]), in a local planar frame. */
function pointSegmentM(p: number[], a: number[], b: number[]): number {
  const k = mPerLng(p[1]);
  const [px, py, ax, ay, bx, by] = [p[0] * k, p[1] * M_PER_LAT, a[0] * k, a[1] * M_PER_LAT, b[0] * k, b[1] * M_PER_LAT];
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Minimum distance in metres between two outlines; 0 if they overlap. */
function outlineDistanceM(a: Ring[], b: Polygons): number {
  const aRings = [a[0]];
  const bRings = b.map((p) => p[0]);
  if (aRings[0].some((p) => inPolygons(p as [number, number], b))) return 0;
  if (bRings.some((r) => r.some((p) => inRing(p as [number, number], aRings[0])))) return 0;
  let best = Infinity;
  for (const ra of aRings)
    for (const rb of bRings) {
      for (const p of ra) for (let i = 0; i < rb.length - 1; i++) best = Math.min(best, pointSegmentM(p, rb[i], rb[i + 1]));
      for (const p of rb) for (let i = 0; i < ra.length - 1; i++) best = Math.min(best, pointSegmentM(p, ra[i], ra[i + 1]));
    }
  return best;
}

export type BuildingName = { name: string; levels: number | null; source: string };

/**
 * Name for a hovered footprint, in order:
 *   1. a lat/lng override whose point lies inside the footprint (overrides apply last, so win);
 *   2. the OSM outline containing the cursor's map position (smallest, if outlines nest);
 *   3. the OSM outline nearest the cursor among those within `fallbackM` of the footprint.
 * Otherwise null: never the nearest building beyond that.
 */
export function nameForFootprint(
  cursor: [number, number],
  footprint: Ring[],
  fallbackM = 5,
): BuildingName | null {
  const override = byPoint.find((o) => inRing([o.lng!, o.lat!], footprint[0]));
  if (override) return { name: override.name, levels: null, source: 'override' };

  const [x, y] = cursor;
  const containing = INDEX.filter(
    ({ bbox, landmark }) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3] && inPolygons(cursor, landmark.polygons),
  ).sort((a, b) => a.areaDeg - b.areaDeg)[0];
  if (containing) return pick(containing.landmark);

  const pad = fallbackM / M_PER_LAT;
  const padLng = fallbackM / mPerLng(y);
  const fx = footprint[0].map((p) => p[0]);
  const fy = footprint[0].map((p) => p[1]);
  const [minX, minY, maxX, maxY] = [Math.min(...fx) - padLng, Math.min(...fy) - pad, Math.max(...fx) + padLng, Math.max(...fy) + pad];
  const near = INDEX.filter(({ bbox }) => bbox[2] >= minX && bbox[0] <= maxX && bbox[3] >= minY && bbox[1] <= maxY)
    .filter(({ landmark }) => outlineDistanceM(footprint, landmark.polygons) <= fallbackM)
    .map(({ landmark }) => ({
      landmark,
      d: Math.min(...landmark.polygons.flatMap((p) => p[0].slice(0, -1).map((a, i) => pointSegmentM(cursor, a, p[0][i + 1])))),
    }))
    .sort((a, b) => a.d - b.d)[0];
  return near ? pick(near.landmark) : null;
}

/** The named building whose OSM outline contains a point (smallest, if outlines nest). */
export function landmarkAt(lng: number, lat: number): Landmark | undefined {
  return INDEX.filter(
    ({ bbox, landmark }) => lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] && inPolygons([lng, lat], landmark.polygons),
  ).sort((a, b) => a.areaDeg - b.areaDeg)[0]?.landmark;
}

const pick = (l: Landmark): BuildingName => ({ name: l.name, levels: l.levels, source: l.nameSource });
