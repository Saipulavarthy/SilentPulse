#!/usr/bin/env node
// One-off: fetch named buildings on the UMass Amherst campus from OpenStreetMap (Overpass API)
// and write data/umassBuildings.json with each building's outline. The app reads that file;
// it never calls Overpass itself.
//
//   node scripts/fetch-umass-buildings.mjs
//
// Naming, in order:
//   1. The building's own tags: name, official_name, alt_name, short_name.
//   2. Only for buildings still unnamed: a named amenity / university / office / tourism
//      feature (node or area) that sits inside the building.
// Manual fixes live in data/umassBuildingOverrides.json and are applied by the app, last.
//
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = fileURLToPath(new URL('../data/umassBuildings.json', import.meta.url));
const CAMPUS_NAME = 'University of Massachusetts Amherst';
const NAME_KEYS = ['name', 'official_name', 'alt_name', 'short_name'];
const POI_KEYS = ['university', 'amenity', 'office', 'tourism'];

async function overpass(query) {
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'silentpulse-data-script' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(`Overpass unreachable:\n  ${errors.join('\n  ')}`);
}

/** Campus bounding box from OSM's own university area, not a hand-drawn box. */
async function campusBbox() {
  const data = await overpass(
    `[out:json][timeout:60];(way["amenity"="university"]["name"="${CAMPUS_NAME}"];relation["amenity"="university"]["name"="${CAMPUS_NAME}"];);out bb tags;`,
  );
  const bounds = data.elements.map((e) => e.bounds).filter(Boolean);
  if (bounds.length === 0) throw new Error(`No OSM area named "${CAMPUS_NAME}" found`);
  return {
    south: Math.min(...bounds.map((b) => b.minlat)),
    west: Math.min(...bounds.map((b) => b.minlon)),
    north: Math.max(...bounds.map((b) => b.maxlat)),
    east: Math.max(...bounds.map((b) => b.maxlon)),
  };
}

// ---- geometry (lng/lat pairs) -------------------------------------------------------------

const pt = (g) => [g.lon, g.lat];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Joins way segments into closed rings (multipolygon members are often split). */
function stitch(segments) {
  const open = segments.map((s) => s.map(pt)).filter((s) => s.length > 1);
  const rings = [];
  while (open.length) {
    let ring = open.shift();
    let grown = true;
    while (!same(ring[0], ring.at(-1)) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i];
        if (same(ring.at(-1), s[0])) ring = ring.concat(s.slice(1));
        else if (same(ring.at(-1), s.at(-1))) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(ring[0], s.at(-1))) ring = s.concat(ring.slice(1));
        else if (same(ring[0], s[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (same(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygons = (p, polygons) => polygons.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

const areaM2 = (polygons) =>
  polygons.reduce((s, [outer, ...holes]) => s + Math.abs(ringArea(outer)) - holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0), 0) *
  111_320 ** 2 *
  Math.cos(((polygons[0]?.[0]?.[0]?.[1] ?? 42.39) * Math.PI) / 180);

/** Area-weighted centroid of the outer rings. */
function centroid(polygons) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const [outer] of polygons) {
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const cross = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
      a += cross;
      cx += (outer[j][0] + outer[i][0]) * cross;
      cy += (outer[j][1] + outer[i][1]) * cross;
    }
  }
  return Math.abs(a) < 1e-14 ? polygons[0][0][0] : [cx / (3 * a), cy / (3 * a)];
}

/** Outline polygons (outer ring + holes) for a way or a multipolygon/building relation. */
function polygonsOf(e) {
  if (e.type === 'way') {
    const ring = e.geometry?.map(pt) ?? [];
    return ring.length >= 4 && same(ring[0], ring.at(-1)) ? [[ring]] : [];
  }
  const members = (e.members ?? []).filter((m) => m.type === 'way' && m.geometry);
  const outers = stitch(members.filter((m) => m.role === 'outer' || m.role === 'outline' || m.role === '').map((m) => m.geometry));
  const inners = stitch(members.filter((m) => m.role === 'inner').map((m) => m.geometry));
  return outers.map((outer) => [outer, ...inners.filter((h) => inRing(h[0], outer))]);
}

const nameOf = (tags = {}) => {
  for (const k of NAME_KEYS) if (tags[k]?.trim()) return { name: tags[k].trim(), key: k };
  return null;
};

const toNumber = (v) => {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const round = (polygons) => polygons.map((poly) => poly.map((ring) => ring.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))])));

// ---- fetch ---------------------------------------------------------------------------------

const bbox = await campusBbox();
const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
console.log('Campus bbox:', bbox);

const buildingData = await overpass(`[out:json][timeout:180];(way["building"](${b});relation["building"](${b}););out geom;`);
const poiData = await overpass(
  `[out:json][timeout:180];(${POI_KEYS.map((k) => `node["${k}"][~"^(${NAME_KEYS.join('|')})$"~"."](${b});way["${k}"][~"^(${NAME_KEYS.join('|')})$"~"."](${b});relation["${k}"][~"^(${NAME_KEYS.join('|')})$"~"."](${b});`).join('')});out geom;`,
);

const buildings = buildingData.elements
  .map((e) => ({ e, polygons: polygonsOf(e) }))
  .filter(({ polygons }) => polygons.length > 0)
  .map(({ e, polygons }) => ({ e, polygons, area: areaM2(polygons), own: nameOf(e.tags) }));

// Named features that are not buildings themselves, as a point plus (for areas) their size.
const pois = poiData.elements
  .filter((e) => !e.tags.building)
  .map((e) => {
    const named = nameOf(e.tags);
    const key = POI_KEYS.find((k) => e.tags[k]);
    if (!named || !key) return null;
    if (e.type === 'node') return { e, named, key, point: [e.lon, e.lat], area: 0 };
    const polygons = polygonsOf(e);
    if (polygons.length === 0) return null;
    return { e, named, key, point: centroid(polygons), area: areaM2(polygons) };
  })
  .filter(Boolean);

let fromTags = 0;
let fromPoi = 0;
const out = [];
for (const bd of buildings) {
  let name = bd.own?.name ?? null;
  let nameSource = bd.own ? bd.own.key : null;
  if (!name) {
    // Areas must fit inside the building (excludes campus-wide areas); bigger areas first,
    // then nodes by key priority, then alphabetically, so the choice is deterministic.
    const inside = pois
      .filter((p) => inPolygons(p.point, bd.polygons) && p.area <= bd.area * 1.1)
      .sort((p, q) => q.area - p.area || POI_KEYS.indexOf(p.key) - POI_KEYS.indexOf(q.key) || p.named.name.localeCompare(q.named.name));
    if (inside[0]) {
      name = inside[0].named.name;
      nameSource = `${inside[0].e.type}/${inside[0].e.id} ${inside[0].key}=${inside[0].e.tags[inside[0].key]}`;
    }
  }
  if (!name) continue;
  if (nameSource.includes('/')) fromPoi++;
  else fromTags++;
  const [lng, lat] = centroid(bd.polygons);
  out.push({
    name,
    nameSource,
    osmId: `${bd.e.type}/${bd.e.id}`,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    levels: toNumber(bd.e.tags['building:levels']),
    height: toNumber(bd.e.tags.height),
    polygons: round(bd.polygons),
  });
}
out.sort((p, q) => p.name.localeCompare(q.name) || p.osmId.localeCompare(q.osmId));

writeFileSync(
  OUT,
  `${JSON.stringify({
    attribution: '© OpenStreetMap contributors, ODbL 1.0',
    source: 'Overpass API',
    generatedAt: new Date().toISOString(),
    bbox,
    count: out.length,
    buildings: out,
  })}\n`,
);
console.log(
  `${buildings.length} building outlines; wrote ${out.length} named (${fromTags} from building tags, ${fromPoi} from a feature inside)` +
    ` to data/umassBuildings.json`,
);
