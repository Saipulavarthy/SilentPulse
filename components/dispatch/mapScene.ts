// Pure geometry for the dispatch map: footprint lookup, incident grouping, projection.

import type { Incident } from '@/types/incident';

type Ring = [number, number][];
type PolygonCoords = Ring[];

type Part = {
  polygon: PolygonCoords;
  /** Metres, from the tile's render_height / render_min_height. */
  height: number;
  base: number;
};

/** The building an incident is in, as found in the loaded tiles. */
export type Footprint = {
  /** Stable per building: rounded centroid of the outline's outer ring. */
  key: string;
  /** The building's ground outline: used to group incidents and for the selection outline. */
  outline: PolygonCoords;
  /** What is actually extruded: the building's parts, each at its own height. */
  parts: Part[];
  /** Roof height directly above the incident's GPS point, metres. */
  roofHeight: number;
};

export type BuildingFeature = {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown };
};

/** An incident group: one per building, or one per incident with no building under it. */
export type SceneGroup = {
  key: string;
  /** Highest severity first; the first one is selected when the badge is clicked. */
  incidents: MappedIncident[];
  footprint: Footprint | null;
  /** Badge anchor: the primary incident's GPS point, at roof height if on a building. */
  lng: number;
  lat: number;
  altitude: number;
};

/** An incident with a usable GPS fix. Incidents without one are never drawn on the map. */
export type MappedIncident = Incident & { gps: NonNullable<Incident['gps']> };

/** Drawn on the map: not resolved, and has a GPS fix. */
export const isDrawn = (i: Incident): i is MappedIncident =>
  i.status !== 'RESOLVED' && i.gps !== undefined && Number.isFinite(i.gps.lat) && Number.isFinite(i.gps.lng);

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(p: [number, number], polygon: PolygonCoords): boolean {
  return inRing(p, polygon[0]) && !polygon.slice(1).some((hole) => inRing(p, hole));
}

function polygonsOf(geometry: BuildingFeature['geometry']): PolygonCoords[] {
  if (geometry.type === 'Polygon') return [geometry.coordinates as PolygonCoords];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as PolygonCoords[];
  return [];
}

function centroid(ring: Ring): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

const keyOf = ([x, y]: [number, number]) => `${x.toFixed(5)},${y.toFixed(5)}`;

/** Stable key for a building outline: its rounded centroid. */
export const buildingKey = (outline: PolygonCoords) => keyOf(centroid(outline[0]));

/** Planar area in m², good enough to compare footprints at campus scale. */
function areaM2(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  const lat = ring[0]?.[1] ?? 0;
  return Math.abs(a / 2) * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180);
}

export type TilePolygon = Part & {
  hidden: boolean;
  area: number;
  centre: [number, number];
  bbox: [number, number, number, number];
};

/** Every building polygon part in the given tile features, with precomputed area/centre/bbox. */
export function tilePolygons(features: BuildingFeature[]): TilePolygon[] {
  const out: TilePolygon[] = [];
  for (const f of features) {
    const props = f.properties ?? {};
    for (const polygon of polygonsOf(f.geometry)) {
      const ring = polygon[0];
      if (!ring || ring.length < 4) continue;
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      out.push({
        polygon,
        height: Number(props.render_height ?? 0),
        base: Number(props.render_min_height ?? 0),
        hidden: Boolean(props.hide_3d),
        area: areaM2(ring),
        centre: centroid(ring),
        bbox: [minX, minY, maxX, maxY],
      });
    }
  }
  return out;
}

const bboxHas = (b: TilePolygon['bbox'], [x, y]: [number, number]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/**
 * The building a polygon belongs to. A building drawn through `building:part`s comes as a
 * `hide_3d` outline plus separate parts: the outline is the building, the parts inside it
 * are what gets extruded. Otherwise the polygon is the building on its own.
 */
export function buildingOf(polygons: TilePolygon[], seed: TilePolygon): { outline: PolygonCoords; parts: Part[] } {
  const outline = seed.hidden
    ? seed
    : polygons
        .filter((t) => t.hidden && t.area >= seed.area && bboxHas(t.bbox, seed.centre) && inPolygon(seed.centre, t.polygon))
        .sort((a, b) => b.area - a.area)[0];
  if (!outline) return { outline: seed.polygon, parts: [seed] };

  const seen = new Set<string>();
  const parts = polygons.filter((t) => {
    if (t.hidden || t.area > outline.area * 1.05 || !bboxHas(outline.bbox, t.centre) || !inPolygon(t.centre, outline.polygon)) return false;
    const k = `${keyOf(t.centre)}@${t.height}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { outline: outline.polygon, parts: parts.length ? parts : [outline] };
}

/**
 * Finds the building under each incident's GPS point in the loaded tiles.
 *
 * Tiles merge same-height buildings into multipolygons, so each polygon part is tested on
 * its own. A building drawn through `building:part`s comes as a `hide_3d` outline plus
 * separate parts: the outline is the building, the parts inside it are what gets extruded.
 *
 * No containing polygon → null; never the nearest building. Incidents whose point is not
 * currently in view keep their previous result, since their tiles may simply not be loaded.
 */
/**
 * Tile footprint under a lat/lng, or null if none of the loaded tiles contain the point.
 * Used to colour named campus buildings that fall inside a GPS uncertainty circle.
 */
export function footprintAtPoint(
  polygons: TilePolygon[],
  lng: number,
  lat: number,
): Footprint | null {
  const p: [number, number] = [lng, lat];
  const containing = polygons.filter((t) => bboxHas(t.bbox, p) && inPolygon(p, t.polygon));
  if (containing.length === 0) return null;
  const visible = containing.filter((t) => !t.hidden);
  const roofHeight = Math.max(0, ...visible.map((t) => t.height), 0);
  const seed =
    containing.filter((t) => t.hidden).sort((a, b) => b.area - a.area)[0] ??
    visible.sort((a, b) => b.height - a.height || b.area - a.area)[0];
  if (!seed) return null;
  const { outline, parts } = buildingOf(polygons, seed);
  return {
    key: buildingKey(outline),
    outline,
    parts: parts.map(({ polygon, height, base }) => ({ polygon, height, base })),
    roofHeight,
  };
}

/**
 * Synthetic extrusion from an OSM outline when tiles have not loaded that building yet.
 * Height ≈ levels × 3.5 m (campus default).
 */
export function footprintFromOutline(
  key: string,
  outline: PolygonCoords,
  levels: number | null,
): Footprint {
  const height = Math.max(3.5, (levels && levels > 0 ? levels : 2) * 3.5);
  return {
    key,
    outline,
    parts: [{ polygon: outline, height, base: 0 }],
    roofHeight: height,
  };
}

export function findFootprints(
  polygons: TilePolygon[],
  incidents: MappedIncident[],
  isInView: (lng: number, lat: number) => boolean,
  previous: Map<string, Footprint | null>,
): Map<string, Footprint | null> {
  const result = new Map<string, Footprint | null>();

  for (const i of incidents) {
    const p: [number, number] = [i.gps.lng, i.gps.lat];
    const found = footprintAtPoint(polygons, p[0], p[1]);
    if (!found) {
      result.set(i._id, isInView(p[0], p[1]) ? null : (previous.get(i._id) ?? null));
      continue;
    }
    result.set(i._id, found);
  }
  return result;
}

/**
 * Groups drawn incidents by building: an incident joins a group when its GPS point lies
 * inside that group's building outline (robust to the same building appearing in several
 * tiles). Incidents with no building stay on their own.
 */
export function groupIncidents(incidents: MappedIncident[], footprints: Map<string, Footprint | null>): SceneGroup[] {
  const groups: SceneGroup[] = [];
  const sorted = [...incidents].sort(
    (a, b) => b.severityScore - a.severityScore || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  for (const i of sorted) {
    const footprint = footprints.get(i._id) ?? null;
    const p: [number, number] = [i.gps.lng, i.gps.lat];
    const existing = footprint
      ? groups.find((g) => g.footprint && (g.footprint.key === footprint.key || inPolygon(p, g.footprint.outline)))
      : undefined;
    if (existing) {
      existing.incidents.push(i);
      continue;
    }
    groups.push({
      key: footprint ? `b:${footprint.key}` : `g:${i._id}`,
      incidents: [i],
      footprint,
      lng: i.gps.lng,
      lat: i.gps.lat,
      altitude: footprint ? footprint.roofHeight : 0,
    });
  }
  return groups;
}

/**
 * Pushes every vertex `metres` away from the ring centroid, so the coloured shell sits just
 * outside the base building instead of z-fighting with it. Holes are dropped.
 */
export function inflate(polygon: PolygonCoords, metres: number): PolygonCoords {
  const ring = polygon[0];
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((cy * Math.PI) / 180);
  return [
    ring.map(([x, y]) => {
      const dx = (x - cx) * mPerLng;
      const dy = (y - cy) * mPerLat;
      const d = Math.hypot(dx, dy) || 1;
      const k = (d + metres) / d;
      return [cx + (dx * k) / mPerLng, cy + (dy * k) / mPerLat];
    }),
  ];
}

/** Ground circle of `radiusM` metres as a 64-point polygon. */
export function circlePolygon(lng: number, lat: number, radiusM: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let k = 0; k <= 64; k++) {
    const a = (k / 64) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

type ScreenPoint = { x: number; y: number };

function inScreenPolygon({ x, y }: ScreenPoint, pts: ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (pts[i].y > y !== pts[j].y > y && x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
  }
  return inside;
}

/**
 * Whether the cursor is over this polygon's extrusion on screen (roof, base or any wall),
 * and how far from the camera it is (smaller = nearer), or null if not hit.
 */
export function prismHit(
  matrix: ArrayLike<number>,
  worldSize: number,
  width: number,
  height: number,
  part: Pick<TilePolygon, 'polygon' | 'height' | 'base'>,
  cursor: ScreenPoint,
): number | null {
  const ring = part.polygon[0];
  const top: ScreenPoint[] = [];
  const bottom: ScreenPoint[] = [];
  let depth = Infinity;
  for (const [lng, lat] of ring) {
    const t = projectWithAltitude(matrix, worldSize, width, height, lng, lat, part.height);
    const b = projectWithAltitude(matrix, worldSize, width, height, lng, lat, part.base);
    if (!t || !b) return null;
    top.push(t);
    bottom.push(b);
    depth = Math.min(depth, t.w, b.w);
  }
  const xs = [...top, ...bottom].map((p) => p.x);
  const ys = [...top, ...bottom].map((p) => p.y);
  if (cursor.x < Math.min(...xs) || cursor.x > Math.max(...xs) || cursor.y < Math.min(...ys) || cursor.y > Math.max(...ys)) return null;
  if (inScreenPolygon(cursor, top) || inScreenPolygon(cursor, bottom)) return depth;
  for (let i = 0; i < ring.length - 1; i++) {
    if (inScreenPolygon(cursor, [bottom[i], bottom[i + 1], top[i + 1], top[i]])) return depth;
  }
  return null;
}

/** Inverse of a column-major 4×4 matrix, or null if singular. */
function invert4(m: ArrayLike<number>): number[] | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** The lng/lat where the cursor's ray meets the horizontal plane at `altitude` metres. */
function unprojectAtAltitude(
  matrix: ArrayLike<number>,
  worldSize: number,
  width: number,
  height: number,
  cursor: ScreenPoint,
  altitude: number,
): [number, number] | null {
  const inv = invert4(matrix);
  if (!inv) return null;
  const nx = (cursor.x / width) * 2 - 1;
  const ny = 1 - (cursor.y / height) * 2;
  const at = (nz: number) => {
    const o = [0, 1, 2, 3].map((r) => inv[r] * nx + inv[4 + r] * ny + inv[8 + r] * nz + inv[12 + r]);
    return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
  };
  const near = at(-1);
  const far = at(1);
  if (far[2] === near[2]) return null;
  const t = (altitude - near[2]) / (far[2] - near[2]);
  const wx = near[0] + t * (far[0] - near[0]);
  const wy = near[1] + t * (far[1] - near[1]);
  const lng = (wx / worldSize) * 360 - 180;
  const lat = (360 / Math.PI) * Math.atan(Math.exp(((180 - (wy / worldSize) * 360) * Math.PI) / 180)) - 90;
  return [lng, lat];
}

/** Closest point to p on the ring's edges (lng/lat, small-area planar approximation). */
function nearestOnRing(p: [number, number], ring: Ring): [number, number] {
  const k = Math.cos((p[1] * Math.PI) / 180);
  let best: [number, number] = ring[0];
  let bestD = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const dx = (bx - ax) * k;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, (((p[0] - ax) * k) * dx + (p[1] - ay) * dy) / len)) : 0;
    const q: [number, number] = [ax + t * (bx - ax), ay + t * (by - ay)];
    const d = Math.hypot((q[0] - p[0]) * k, q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * The cursor's map position on the hovered extrusion: where its ray meets the roof, else the
 * base, else (a wall) the nearest point on the footprint's edge.
 */
export function surfacePoint(
  matrix: ArrayLike<number>,
  worldSize: number,
  width: number,
  height: number,
  cursor: ScreenPoint,
  part: Pick<TilePolygon, 'polygon' | 'height' | 'base'>,
): [number, number] | null {
  const roof = unprojectAtAltitude(matrix, worldSize, width, height, cursor, part.height);
  if (roof && inPolygon(roof, part.polygon)) return roof;
  const base = unprojectAtAltitude(matrix, worldSize, width, height, cursor, part.base);
  if (base && inPolygon(base, part.polygon)) return base;
  return roof ? nearestOnRing(roof, part.polygon[0]) : null;
}

/**
 * Screen position (CSS px) of a lng/lat at `altitude` metres, using the matrix MapLibre
 * hands to custom layers: world-pixel x/y (Web Mercator × worldSize), z in metres.
 * Null when the point is behind the camera.
 */
export function projectWithAltitude(
  matrix: ArrayLike<number>,
  worldSize: number,
  width: number,
  height: number,
  lng: number,
  lat: number,
  altitude: number,
): { x: number; y: number; w: number } | null {
  const mx = ((180 + lng) / 360) * worldSize;
  const my = ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) * worldSize;
  const v = [mx, my, altitude, 1];
  const out = [0, 1, 2, 3].map((r) => matrix[r] * v[0] + matrix[4 + r] * v[1] + matrix[8 + r] * v[2] + matrix[12 + r] * v[3]);
  if (out[3] <= 0) return null;
  return { x: ((out[0] / out[3] + 1) / 2) * width, y: ((1 - out[1] / out[3]) / 2) * height, w: out[3] };
}
