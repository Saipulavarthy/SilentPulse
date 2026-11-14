#!/usr/bin/env node
// One-off: fetch named buildings on the UMass Amherst campus from OpenStreetMap (Overpass API)
// and write data/umassBuildings.json. The app reads that file; it never calls Overpass itself.
//
//   node scripts/fetch-umass-buildings.mjs
//
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = fileURLToPath(new URL('../data/umassBuildings.json', import.meta.url));
const CAMPUS_NAME = 'University of Massachusetts Amherst';

async function overpass(query) {
  const errors = [];
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'silentpulse-data-script' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
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

/** Area-weighted centroid of closed rings ({lat, lon}[]), in a local planar approximation. */
function centroidOfRings(rings) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j].lon * ring[i].lat - ring[i].lon * ring[j].lat;
      a += cross;
      cx += (ring[j].lon + ring[i].lon) * cross;
      cy += (ring[j].lat + ring[i].lat) * cross;
    }
  }
  if (Math.abs(a) < 1e-14) return null;
  return { lat: cy / (3 * a), lng: cx / (3 * a) };
}

const isClosed = (g) => g.length > 3 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon;

function centroidOf(element) {
  if (element.type === 'way' && element.geometry && isClosed(element.geometry)) {
    return { ...centroidOfRings([element.geometry]), method: 'polygon' };
  }
  if (element.type === 'relation') {
    const outers = (element.members ?? []).filter((m) => m.role === 'outer' && m.geometry && isClosed(m.geometry));
    const c = outers.length ? centroidOfRings(outers.map((m) => m.geometry)) : null;
    if (c) return { ...c, method: 'polygon' };
  }
  // Unclosed geometry (e.g. a multipolygon whose outer ring is split across ways): bbox centre.
  const b = element.bounds;
  return b ? { lat: (b.minlat + b.maxlat) / 2, lng: (b.minlon + b.maxlon) / 2, method: 'bbox' } : null;
}

const toNumber = (v) => {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const bbox = await campusBbox();
console.log('Campus bbox:', bbox);
const data = await overpass(
  `[out:json][timeout:120];(way["building"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});relation["building"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom tags;`,
);

let bboxFallbacks = 0;
const buildings = data.elements
  .map((e) => {
    const c = centroidOf(e);
    if (!c) return null;
    if (c.method === 'bbox') bboxFallbacks++;
    return {
      name: e.tags.name,
      osmId: `${e.type}/${e.id}`,
      lat: Number(c.lat.toFixed(6)),
      lng: Number(c.lng.toFixed(6)),
      levels: toNumber(e.tags['building:levels']),
      height: toNumber(e.tags.height),
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name) || a.osmId.localeCompare(b.osmId));

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      attribution: '© OpenStreetMap contributors, ODbL 1.0',
      source: 'Overpass API',
      generatedAt: new Date().toISOString(),
      bbox,
      count: buildings.length,
      buildings,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Wrote ${buildings.length} named buildings to data/umassBuildings.json` +
    ` (${buildings.filter((b) => b.levels !== null).length} with levels, ${buildings.filter((b) => b.height !== null).length} with height, ${bboxFallbacks} bbox-centre fallbacks)`,
);
