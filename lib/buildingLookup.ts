import fs from "node:fs";
import path from "node:path";
import type { Building } from "@/types/incident";

/** GeoJSON-style ring: [lng, lat][]. */
type LngLat = [number, number];
type Ring = LngLat[];
/** One polygon = outer ring + optional hole rings. */
type PolygonRings = Ring[];
/** MultiPolygon: array of polygons. */
type MultiPolygon = PolygonRings[];

type RawBuilding = {
  name: string;
  osmId: string;
  lat: number;
  lng: number;
  levels: number | null;
  height: number | null;
  polygons: MultiPolygon;
};

type OsmOverride = { osmId: string; name: string };
type PointOverride = { lat: number; lng: number; name: string };
type OverrideEntry = OsmOverride | PointOverride;

type IndexedBuilding = {
  osmId: string;
  name: string;
  levels: number | null;
  height: number | null;
  polygons: MultiPolygon;
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  area: number;
};

const NEAR_METERS = 25;
const M_PER_DEG_LAT = 111_320;

function readDataJson<T>(fileName: string): T {
  // Scoped under data/ so Turbopack does not trace the whole project.
  const full = path.join(process.cwd(), "data", fileName);
  return JSON.parse(fs.readFileSync(full, "utf8")) as T;
}

const buildingsData = readDataJson<{ buildings: RawBuilding[] }>(
  "umassBuildings.json",
);
const overridesData = readDataJson<{ overrides?: OverrideEntry[] }>(
  "umassBuildingOverrides.json",
);
const buildingNotesData = readDataJson<
  Record<string, { type?: string; notes?: string } | string>
>("buildingNotes.json");

function metersPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Shoelace area in squared degrees (outer ring only) — for relative ranking. */
function ringAreaDeg2(ring: Ring): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function polygonBbox(polygons: MultiPolygon): IndexedBuilding["bbox"] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLng, minLat, maxLng, maxLat };
}

function totalOuterArea(polygons: MultiPolygon): number {
  let area = 0;
  for (const poly of polygons) {
    if (poly[0]) area += ringAreaDeg2(poly[0]);
  }
  return area;
}

/** Classic ray casting; ring is [lng, lat][]. */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Inside outer ring and outside all holes. */
function pointInPolygon(
  lng: number,
  lat: number,
  rings: PolygonRings,
): boolean {
  if (!rings[0] || rings[0].length < 3) return false;
  if (!pointInRing(lng, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (rings[h] && pointInRing(lng, lat, rings[h])) return false;
  }
  return true;
}

function pointInMultiPolygon(
  lng: number,
  lat: number,
  polygons: MultiPolygon,
): boolean {
  for (const poly of polygons) {
    if (pointInPolygon(lng, lat, poly)) return true;
  }
  return false;
}

function inBbox(
  lng: number,
  lat: number,
  bbox: IndexedBuilding["bbox"],
): boolean {
  return (
    lng >= bbox.minLng &&
    lng <= bbox.maxLng &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

/** Distance in meters from point to segment (local equirectangular). */
function pointToSegmentMeters(
  lat: number,
  lng: number,
  a: LngLat,
  b: LngLat,
): number {
  const mLng = metersPerDegLng(lat);
  const ax = (a[0] - lng) * mLng;
  const ay = (a[1] - lat) * M_PER_DEG_LAT;
  const bx = (b[0] - lng) * mLng;
  const by = (b[1] - lat) * M_PER_DEG_LAT;
  const abx = bx - ax;
  const aby = by - ay;
  const apx = -ax;
  const apy = -ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 > 0 ? (apx * abx + apy * aby) / abLen2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(cx, cy);
}

/** Min distance from point to any exterior outline segment. */
function distanceToOutlineMeters(
  lat: number,
  lng: number,
  polygons: MultiPolygon,
): number {
  let min = Infinity;
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 2) continue;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      const d = pointToSegmentMeters(lat, lng, a, b);
      if (d < min) min = d;
    }
  }
  return min;
}

function computeFloors(levels: number | null, height: number | null): number {
  if (typeof levels === "number" && Number.isFinite(levels) && levels > 0) {
    return Math.round(levels);
  }
  if (typeof height === "number" && Number.isFinite(height) && height > 0) {
    return Math.max(1, Math.round(height / 3.5));
  }
  return 1;
}

function toBuilding(entry: IndexedBuilding): Building {
  const noteEntry = buildingNotesData[entry.name];
  const extra =
    noteEntry && typeof noteEntry === "object" && !Array.isArray(noteEntry)
      ? noteEntry
      : undefined;
  return {
    name: entry.name,
    type: extra?.type?.trim() || "Building",
    floors: computeFloors(entry.levels, entry.height),
    ...(extra?.notes?.trim() ? { notes: extra.notes.trim() } : {}),
  };
}

function buildIndex(): IndexedBuilding[] {
  const indexed: IndexedBuilding[] = buildingsData.buildings.map((b) => ({
    osmId: b.osmId,
    name: b.name,
    levels: b.levels,
    height: b.height,
    polygons: b.polygons,
    bbox: polygonBbox(b.polygons),
    area: totalOuterArea(b.polygons),
  }));

  const byOsm = new Map(indexed.map((b) => [b.osmId, b]));
  const overrides = overridesData.overrides ?? [];

  for (const o of overrides) {
    if ("osmId" in o && typeof o.osmId === "string" && o.name) {
      const hit = byOsm.get(o.osmId);
      if (hit) hit.name = o.name;
      continue;
    }
    if (
      typeof (o as PointOverride).lat === "number" &&
      typeof (o as PointOverride).lng === "number" &&
      o.name
    ) {
      const { lat, lng, name } = o as PointOverride;
      const containing = indexed.filter(
        (b) =>
          inBbox(lng, lat, b.bbox) &&
          pointInMultiPolygon(lng, lat, b.polygons),
      );
      if (containing.length === 0) continue;
      containing.sort((a, b) => a.area - b.area);
      containing[0].name = name;
    }
  }

  return indexed;
}

const INDEX: IndexedBuilding[] = buildIndex();

/**
 * Resolve a UMass building for a GPS point.
 * Containment (smallest footprint wins) → else nearest outline within 25m → else null.
 */
export function buildingAt(lat: number, lng: number): Building | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const containing: IndexedBuilding[] = [];
  for (const b of INDEX) {
    if (!inBbox(lng, lat, b.bbox)) continue;
    if (pointInMultiPolygon(lng, lat, b.polygons)) containing.push(b);
  }

  if (containing.length > 0) {
    containing.sort((a, b) => a.area - b.area);
    return toBuilding(containing[0]);
  }

  let best: IndexedBuilding | null = null;
  let bestDist = Infinity;
  const padLat = NEAR_METERS / M_PER_DEG_LAT;
  const padLng = NEAR_METERS / Math.max(metersPerDegLng(lat), 1e-6);

  for (const b of INDEX) {
    if (
      lng < b.bbox.minLng - padLng ||
      lng > b.bbox.maxLng + padLng ||
      lat < b.bbox.minLat - padLat ||
      lat > b.bbox.maxLat + padLat
    ) {
      continue;
    }
    const d = distanceToOutlineMeters(lat, lng, b.polygons);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }

  if (best && bestDist <= NEAR_METERS) return toBuilding(best);
  return null;
}
