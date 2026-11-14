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
  incidents: Incident[];
  footprint: Footprint | null;
  /** Badge anchor: the primary incident's GPS point, at roof height if on a building. */
  lng: number;
  lat: number;
  altitude: number;
};

export const isDrawn = (i: Incident) => i.status !== 'RESOLVED';

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(p: [number, number], polygon: PolygonCoords): boolean {
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

/** Planar area in m², good enough to compare footprints at campus scale. */
function areaM2(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  const lat = ring[0]?.[1] ?? 0;
  return Math.abs(a / 2) * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180);
}

type TilePolygon = Part & { hidden: boolean; area: number; centre: [number, number]; bbox: [number, number, number, number] };

function tilePolygons(features: BuildingFeature[]): TilePolygon[] {
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
 * Finds the building under each incident's GPS point in the loaded tiles.
 *
 * Tiles merge same-height buildings into multipolygons, so each polygon part is tested on
 * its own. A building drawn through `building:part`s comes as a `hide_3d` outline plus
 * separate parts: the outline is the building, the parts inside it are what gets extruded.
 *
 * No containing polygon → null; never the nearest building. Incidents whose point is not
 * currently in view keep their previous result, since their tiles may simply not be loaded.
 */
export function findFootprints(
  features: BuildingFeature[],
  incidents: Incident[],
  isInView: (lng: number, lat: number) => boolean,
  previous: Map<string, Footprint | null>,
): Map<string, Footprint | null> {
  const polygons = tilePolygons(features);
  const result = new Map<string, Footprint | null>();

  for (const i of incidents) {
    const p: [number, number] = [i.gps.lng, i.gps.lat];
    const containing = polygons.filter((t) => bboxHas(t.bbox, p) && inPolygon(p, t.polygon));
    if (containing.length === 0) {
      result.set(i._id, isInView(p[0], p[1]) ? null : (previous.get(i._id) ?? null));
      continue;
    }

    const visible = containing.filter((t) => !t.hidden);
    const roofHeight = Math.max(0, ...visible.map((t) => t.height));
    const outline = containing.filter((t) => t.hidden).sort((a, b) => b.area - a.area)[0];

    let parts: Part[];
    let outlinePolygon: PolygonCoords;
    if (outline) {
      const seen = new Set<string>();
      parts = polygons
        .filter((t) => !t.hidden && t.area <= outline.area * 1.05 && bboxHas(outline.bbox, t.centre) && inPolygon(t.centre, outline.polygon))
        .filter((t) => {
          const k = `${keyOf(t.centre)}@${t.height}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      if (parts.length === 0) parts = [outline];
      outlinePolygon = outline.polygon;
    } else {
      const chosen = visible.sort((a, b) => b.height - a.height || b.area - a.area)[0];
      parts = [chosen];
      outlinePolygon = chosen.polygon;
    }

    result.set(i._id, {
      key: keyOf(centroid(outlinePolygon[0])),
      outline: outlinePolygon,
      parts: parts.map(({ polygon, height, base }) => ({ polygon, height, base })),
      roofHeight,
    });
  }
  return result;
}

/**
 * Groups drawn incidents by building: an incident joins a group when its GPS point lies
 * inside that group's building outline (robust to the same building appearing in several
 * tiles). Incidents with no building stay on their own.
 */
export function groupIncidents(incidents: Incident[], footprints: Map<string, Footprint | null>): SceneGroup[] {
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
): { x: number; y: number } | null {
  const mx = ((180 + lng) / 360) * worldSize;
  const my = ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) * worldSize;
  const v = [mx, my, altitude, 1];
  const out = [0, 1, 2, 3].map((r) => matrix[r] * v[0] + matrix[4 + r] * v[1] + matrix[8 + r] * v[2] + matrix[12 + r] * v[3]);
  if (out[3] <= 0) return null;
  return { x: ((out[0] / out[3] + 1) / 2) * width, y: ((1 - out[1] / out[3]) / 2) * height };
}
