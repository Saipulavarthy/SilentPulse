'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
  type JumpToOptions,
} from 'maplibre-gl';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { nameForFootprint } from '@/lib/landmarks';
import type { Incident } from '@/types/incident';
import type { MapPanelProps } from './MapPanel';
import {
  buildingKey,
  buildingOf,
  circlePolygon,
  findFootprints,
  groupIncidents,
  inflate,
  inPolygon,
  isDrawn,
  prismHit,
  projectWithAltitude,
  surfacePoint,
  tilePolygons,
  type BuildingFeature,
  type Footprint,
  type MappedIncident,
  type SceneGroup,
  type TilePolygon,
} from './mapScene';
import { incidentNumber, tierStyle, typeLabel } from './severity';
import { MONO } from './ui';

// MapLibre locates its worker next to its own module, which bundling breaks.
// Let the bundler emit the (self-contained) worker file and point MapLibre at it.
setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);

// OpenFreeMap: free, no API key. Its OpenMapTiles schema exposes building
// `render_height` / `render_min_height` (metres) and a `hide_3d` flag.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const VECTOR_SOURCE = 'openmaptiles';

const PITCH = 60;
const BEARING = -17;
const MIN_OVERVIEW_ZOOM = 15.8;
const SELECTED_ZOOM = 17.2;
/** Panning stays around the UMass Amherst campus. */
const CAMPUS_BOUNDS: [[number, number], [number, number]] = [
  [-72.548, 42.372],
  [-72.508, 42.404],
];
const FALLBACK_CENTER: [number, number] = [-72.527, 42.389];

const GROUND = '#16171a';
const ROAD = '#24252a';
const SLATE = '#5f6673';
const ACCENT = '#38bdf8';

// Satellite: USGS National Map "Imagery Only" (USDA NAIP orthoimagery), public domain, no key.
// Tiles exist to zoom 16 here; MapLibre overzooms beyond that.
const SAT_SOURCE = 'sp-satellite';
const SAT_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const SAT_ATTRIBUTION =
  'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USDA, USGS The National Map: Orthoimagery</a>';
const SAT_PITCH = 40;
/** Tile errors in satellite mode before falling back to 3D. */
const SAT_MAX_ERRORS = 3;

export type MapMode = '3d' | 'sat';
/** The chosen mode, kept in memory for the browser session (survives remounts, not reloads). */
let sessionMode: MapMode = '3d';

const ACCURACY_SOURCE = 'sp-accuracy';
const INCIDENT_BUILDINGS_SOURCE = 'sp-incident-buildings';
const HOVER_SOURCE = 'sp-hover';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// MapLibre's CSS is unlayered, so it beats Tailwind's layered utilities: overrides need `!`.
const MAP_CHROME = [
  '[&_.maplibregl-ctrl-group]:rounded-[2px]! [&_.maplibregl-ctrl-group]:bg-[#121213]! [&_.maplibregl-ctrl-group]:shadow-none!',
  '[&_.maplibregl-ctrl-group]:border! [&_.maplibregl-ctrl-group]:border-neutral-800!',
  '[&_.maplibregl-ctrl-group_button+button]:border-neutral-800! [&_.maplibregl-ctrl-icon]:invert',
  '[&_.maplibregl-ctrl-attrib]:bg-[#0b0b0c]/85! [&_.maplibregl-ctrl-attrib]:text-neutral-500!',
  '[&_.maplibregl-ctrl-attrib_a]:text-neutral-400! [&_.maplibregl-ctrl-attrib-button]:invert',
  '[&_.maplibregl-canvas]:outline-none',
].join(' ');

type Badge = { group: SceneGroup; el: HTMLElement };
type Hover = { key: string; incidents: Incident[] };

export default function IncidentMap({ incidents, selectedId, onSelect }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const footprintsRef = useRef(new Map<string, Footprint | null>());
  const polygonsRef = useRef<TilePolygon[]>([]);
  const hoverRef = useRef<Hover | null>(null);
  const badgesRef = useRef<Badge[]>([]);
  const matrixRef = useRef<ArrayLike<number> | null>(null);
  const lastFlownRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  // Overview frames incidents on campus only, so one far-off GPS fix can't zoom the map out.
  const [initialDrawn] = useState(() => incidents.filter(isDrawn).filter(onCampus));
  const [mode, setMode] = useState<MapMode>(sessionMode);
  const [notice, setNotice] = useState<string | null>(null);
  const modeRef = useRef<MapMode>('3d');
  const stylerRef = useRef<((m: MapMode) => void) | null>(null);
  const modeControlRef = useRef<ModeControl | null>(null);
  const pitchBeforeSatRef = useRef(PITCH);
  const satErrorsRef = useRef(0);

  /** Pitch for camera moves in the current mode. */
  const modePitch = () => (modeRef.current === 'sat' ? SAT_PITCH : PITCH);
  const chooseMode = (next: MapMode) => {
    sessionMode = next;
    setMode(next);
  };

  /** Places every badge for the current camera. Called from the render loop with its matrix. */
  const positionBadges = (frameMatrix?: ArrayLike<number>) => {
    if (frameMatrix) matrixRef.current = frameMatrix;
    const map = mapRef.current;
    const matrix = matrixRef.current;
    if (!map || !matrix) return;
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const worldSize = 512 * 2 ** map.getZoom();
    for (const { group, el } of badgesRef.current) {
      const p = projectWithAltitude(matrix, worldSize, w, h, group.lng, group.lat, group.altitude);
      const visible = p && p.x > -40 && p.x < w + 40 && p.y > -40 && p.y < h + 120;
      el.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) {
        el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, ${group.footprint ? '-100%' : '-50%'})`;
      }
    }
  };

  /** Rebuilds coloured buildings, accuracy circles and badges from the latest props. */
  const renderScene = useEffectEvent(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    const drawn = incidents.filter(isDrawn);
    const groups = groupIncidents(drawn, footprintsRef.current);

    map.getSource<GeoJSONSource>(INCIDENT_BUILDINGS_SOURCE)?.setData({
      type: 'FeatureCollection',
      features: groups.flatMap((g): GeoJSON.Feature[] => {
        if (!g.footprint) return [];
        const state = g.incidents.some((i) => i._id === selectedId)
          ? 'selected'
          : g.incidents.some((i) => i.status === 'ACTIVE')
            ? 'open'
            : 'ack';
        const color = tierStyle(g.incidents[0].severityScore).hex;
        return [
          // Slightly inflated so the coloured shell doesn't z-fight with the slate building.
          ...g.footprint.parts.map((part) => ({
            type: 'Feature' as const,
            properties: { kind: 'part', state, color, height: part.height + 0.6, base: part.base },
            geometry: { type: 'Polygon' as const, coordinates: inflate(part.polygon, 0.6) },
          })),
          {
            type: 'Feature' as const,
            properties: { kind: 'outline', state },
            geometry: { type: 'Polygon' as const, coordinates: inflate(g.footprint.outline, 0.8) },
          },
        ];
      }),
    });

    map.getSource<GeoJSONSource>(ACCURACY_SOURCE)?.setData({
      type: 'FeatureCollection',
      features: drawn
        .filter((i) => i.gps.accuracy !== undefined && i.gps.accuracy > 0)
        .map((i) => circlePolygon(i.gps.lng, i.gps.lat, i.gps.accuracy!)),
    });

    overlay.replaceChildren();
    badgesRef.current = groups.map((group) => {
      const el = createBadge(group, selectedId, onSelect);
      overlay.appendChild(el);
      return { group, el };
    });
    positionBadges();
    map.triggerRepaint();
  });

  /** Finds each incident's footprint in the loaded tiles; re-renders only if something changed. */
  const lookupFootprints = useEffectEvent(() => {
    const map = mapRef.current;
    if (!map) return;
    const polygons = tilePolygons(map.querySourceFeatures(VECTOR_SOURCE, { sourceLayer: 'building' }) as BuildingFeature[]);
    polygonsRef.current = polygons;
    const view = map.getBounds();
    const isInView = (lng: number, lat: number) => map.getZoom() >= 13 && view.contains([lng, lat]);
    const next = findFootprints(polygons, incidents.filter(isDrawn), isInView, footprintsRef.current);
    const signature = (m: Map<string, Footprint | null>) =>
      [...m].map(([id, f]) => `${id}=${f ? `${f.key}@${f.roofHeight}/${f.parts.length}` : '-'}`).sort().join('|');
    if (signature(next) === signature(footprintsRef.current)) return;
    footprintsRef.current = next;
    renderScene();
  });

  /** Removes the hover tooltip, highlight and pointer cursor. */
  const clearHover = () => {
    hoverRef.current = null;
    if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = '';
    map.getSource<GeoJSONSource>(HOVER_SOURCE)?.setData(EMPTY);
  };

  /**
   * Hover: the extruded footprint under the cursor (3D hit test against roofs and walls),
   * named by the OSM building whose centroid lies inside it. No such building → no tooltip.
   */
  const hoverAt = useEffectEvent((point: { x: number; y: number }) => {
    const map = mapRef.current;
    const matrix = matrixRef.current;
    const tooltip = tooltipRef.current;
    if (!map || !matrix || !tooltip || map.isMoving()) return;

    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const worldSize = 512 * 2 ** map.getZoom();
    // Satellite mode has no neutral extrusions: hit-test flat footprints on the ground instead.
    const flat = modeRef.current === 'sat';
    const layer = flat ? 'sp-buildings-flat' : 'sp-buildings-3d';
    const hits = map.queryRenderedFeatures([point.x, point.y], { layers: [layer] }) as BuildingFeature[];
    let hovered: TilePolygon | null = null;
    let nearest = Infinity;
    for (const tilePart of tilePolygons(hits)) {
      if (tilePart.hidden || (!flat && tilePart.height <= 0)) continue;
      const part = flat ? { ...tilePart, height: 0, base: 0 } : tilePart;
      const depth = prismHit(matrix, worldSize, w, h, part, point);
      if (depth !== null && depth < nearest) {
        hovered = part;
        nearest = depth;
      }
    }
    if (!hovered) return clearHover();

    const { outline, parts } = buildingOf(polygonsRef.current, hovered);
    const key = buildingKey(outline);
    const inside = incidents
      .filter((i) => isDrawn(i) && inPolygon([i.gps.lng, i.gps.lat], outline))
      .sort((a, b) => b.severityScore - a.severityScore);
    canvas.style.cursor = inside.length > 0 ? 'pointer' : '';

    // Name by where the cursor actually is on the building, tested against OSM outlines.
    const onSurface = surfacePoint(matrix, worldSize, w, h, point, hovered);
    const name = onSurface ? nameForFootprint(onSurface, outline) : null;

    if (hoverRef.current?.key !== key) {
      map.getSource<GeoJSONSource>(HOVER_SOURCE)?.setData(
        name
          ? {
              type: 'FeatureCollection',
              features: parts.map((part) => ({
                type: 'Feature' as const,
                // Satellite: a thin slab, so the highlight never becomes an extrusion.
                properties: flat ? { height: 0.5, base: 0 } : { height: part.height + 1.2, base: part.base },
                geometry: { type: 'Polygon' as const, coordinates: inflate(part.polygon, 1.2) },
              })),
            }
          : EMPTY,
      );
    }
    hoverRef.current = { key, incidents: inside };

    if (!name) {
      tooltip.style.display = 'none';
      return;
    }
    const line1 = name.levels ? `${name.name} · ${name.levels} floors` : name.name;
    const open = inside.filter((i) => i.status === 'ACTIVE').length;
    const ack = inside.length - open;
    const line2 =
      inside.length === 0
        ? ''
        : ack === 0
          ? `${open} open incident${open === 1 ? '' : 's'}, highest ${inside[0].severityScore}`
          : `${inside.length} incident${inside.length === 1 ? '' : 's'} (${ack} acknowledged), highest ${inside[0].severityScore}`;
    const [first, second] = tooltip.children as unknown as [HTMLElement, HTMLElement];
    first.textContent = line1;
    second.textContent = line2;
    second.style.display = line2 ? 'block' : 'none';

    tooltip.style.display = 'block';
    const flip = point.x + 14 + tooltip.offsetWidth > w;
    const x = flip ? point.x - 14 - tooltip.offsetWidth : point.x + 14;
    const y = Math.min(point.y + 16, h - tooltip.offsetHeight - 4);
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  });

  /** Clicking a building with incidents selects its highest-severity incident. */
  const selectHovered = useEffectEvent(() => {
    const top = hoverRef.current?.incidents[0];
    if (top) onSelect(top._id);
  });

  /** Satellite tiles failing: after a few errors, go back to 3D and say so; the toggle stays usable. */
  const onSatelliteError = useEffectEvent(() => {
    if (modeRef.current !== 'sat') return;
    satErrorsRef.current += 1;
    if (satErrorsRef.current < SAT_MAX_ERRORS) return;
    satErrorsRef.current = 0;
    setNotice('Satellite imagery failed to load. Back to 3D; press SAT or M to retry.');
    chooseMode('3d');
  });

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: STYLE_URL,
      center: FALLBACK_CENTER,
      zoom: MIN_OVERVIEW_ZOOM,
      pitch: PITCH,
      bearing: BEARING,
      maxPitch: 70,
      maxBounds: CAMPUS_BOUNDS,
      attributionControl: { compact: true },
    });
    const overview = overviewCamera(map, initialDrawn);
    map.jumpTo(overview);
    // Three separate controls, so MapLibre stacks them with its standard 10px gap.
    map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new NavigationControl({ showZoom: false, visualizePitch: true }), 'top-left');
    map.addControl(new OverviewControl(() => map.flyTo({ ...overview, pitch: modePitch(), duration: 1200 })), 'top-left');
    const modeControl = new ModeControl((m) => chooseMode(m));
    modeControlRef.current = modeControl;
    map.addControl(modeControl, 'top-left');

    map.on('load', () => {
      restyleBase(map);
      addDispatchLayers(map, positionBadges);
      stylerRef.current = createModeStyler(map);
      setReady(true);
    });
    // Imagery tile failures: fall back to 3D (handled in onSatelliteError).
    map.on('error', (e) => {
      if ((e as { sourceId?: string }).sourceId === SAT_SOURCE) onSatelliteError();
    });
    // Tiles finished loading after a camera move: footprints may now be available.
    map.on('idle', () => lookupFootprints());

    // Hover is read-only: it never changes selection or moves the camera.
    let frame = 0;
    map.on('mousemove', (e) => {
      const { x, y } = e.point;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => hoverAt({ x, y }));
    });
    map.on('mouseout', () => {
      cancelAnimationFrame(frame);
      clearHover();
    });
    map.on('movestart', () => clearHover());
    map.on('click', () => selectHovered());

    mapRef.current = map;
    return () => {
      cancelAnimationFrame(frame);
      map.remove();
      mapRef.current = null;
      stylerRef.current = null;
      modeControlRef.current = null;
    };
  }, [initialDrawn]);

  // Apply the map mode: styling, pitch (40° in satellite, previous pitch restored after), control state.
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!ready || !map || !stylerRef.current) return;
    const previous = modeRef.current;
    stylerRef.current(mode);
    modeRef.current = mode;
    modeControlRef.current?.setMode(mode);
    if (overlay) overlay.dataset.mode = mode;
    if (previous !== mode) {
      if (mode === 'sat') {
        satErrorsRef.current = 0;
        pitchBeforeSatRef.current = map.getPitch();
        map.easeTo({ pitch: SAT_PITCH, duration: 500 });
      } else {
        map.easeTo({ pitch: pitchBeforeSatRef.current, duration: 500 });
      }
    }
  }, [ready, mode]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // M toggles 3D / satellite (ignored while typing or with modifier keys).
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'm') return;
    if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
    chooseMode(modeRef.current === 'sat' ? '3d' : 'sat');
  });
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (ready) lookupFootprints();
  }, [ready, incidents]);

  // Off-campus fixes must stay reachable: widen the pan limits to include them.
  const boundsKey = JSON.stringify(panBounds(incidents.filter(isDrawn)));
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) map.setMaxBounds(JSON.parse(boundsKey));
  }, [ready, boundsKey]);

  useEffect(() => {
    if (ready) renderScene();
  }, [ready, incidents, selectedId]);

  // Fly to the selected incident (not on first load, which keeps the overview).
  const selected = incidents.filter(isDrawn).find((i) => i._id === selectedId);
  const lat = selected?.gps.lat;
  const lng = selected?.gps.lng;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedId || lat === undefined || lng === undefined) return;
    if (lastFlownRef.current === null) {
      lastFlownRef.current = selectedId;
      return;
    }
    if (lastFlownRef.current === selectedId) return;
    lastFlownRef.current = selectedId;
    map.flyTo({ center: [lng, lat], zoom: SELECTED_ZOOM, pitch: modePitch(), bearing: map.getBearing(), duration: 1400 });
  }, [ready, selectedId, lat, lng]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className={`h-full w-full bg-[#16171a] ${MAP_CHROME}`} />
      <div ref={overlayRef} data-mode="3d" className="group/map pointer-events-none absolute inset-0 z-[1] overflow-hidden" />
      {notice && (
        <div
          role="status"
          className={`absolute top-3 left-1/2 z-[3] -translate-x-1/2 rounded-[2px] border border-neutral-700 bg-[#121213] px-3 py-1.5 text-[12px] text-neutral-200 ${MONO}`}
        >
          {notice}
        </div>
      )}
      <div
        ref={tooltipRef}
        role="tooltip"
        className={`pointer-events-none absolute top-0 left-0 z-[2] hidden max-w-[320px] rounded-[2px] border border-neutral-700 bg-[#121213] px-2 py-1 text-[11px] leading-[1.45] ${MONO}`}
      >
        <span className="block text-neutral-100" />
        <span className="block text-neutral-400" />
      </div>
    </div>
  );
}

/**
 * Frames the open incidents: centre on their middle (so they sit mid-panel at any pitch),
 * zoom to fit but never further out than MIN_OVERVIEW_ZOOM.
 */
const onCampus = (i: MappedIncident) =>
  i.gps.lng >= CAMPUS_BOUNDS[0][0] && i.gps.lng <= CAMPUS_BOUNDS[1][0] && i.gps.lat >= CAMPUS_BOUNDS[0][1] && i.gps.lat <= CAMPUS_BOUNDS[1][1];

/** Pan limits: the campus box, widened to include every incident's GPS fix (plus a margin). */
function panBounds(incidents: MappedIncident[]): [[number, number], [number, number]] {
  const pad = 0.01;
  let [[w, s], [e, n]] = CAMPUS_BOUNDS;
  for (const i of incidents) {
    w = Math.min(w, i.gps.lng - pad);
    e = Math.max(e, i.gps.lng + pad);
    s = Math.min(s, i.gps.lat - pad);
    n = Math.max(n, i.gps.lat + pad);
  }
  return [
    [w, s],
    [e, n],
  ];
}

function overviewCamera(map: MapLibreMap, incidents: MappedIncident[]): JumpToOptions {
  if (incidents.length === 0) return { center: FALLBACK_CENTER, zoom: MIN_OVERVIEW_ZOOM, pitch: PITCH, bearing: BEARING };
  const bounds = new LngLatBounds();
  for (const i of incidents) bounds.extend([i.gps.lng, i.gps.lat]);
  const fit = map.cameraForBounds(bounds, { padding: 80, bearing: BEARING });
  const zoom = Math.min(SELECTED_ZOOM, Math.max(MIN_OVERVIEW_ZOOM, fit?.zoom ?? MIN_OVERVIEW_ZOOM));
  return { center: bounds.getCenter(), zoom, pitch: PITCH, bearing: BEARING };
}

/** Lighter ground, quieter roads and labels, no textures or flat building outlines. */
function restyleBase(map: MapLibreMap) {
  type PaintArgs = Parameters<MapLibreMap['setPaintProperty']>;
  const set = (layer: string, prop: PaintArgs[1], value: PaintArgs[2]) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  const hide = (layer: string) => {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', 'none');
  };

  set('background', 'background-color', GROUND);
  set('landcover_wood', 'fill-pattern', undefined);
  set('highway_minor', 'line-color', ROAD);
  set('highway_major_inner', 'line-color', ROAD);
  set('highway_path', 'line-color', '#202125');

  // Flat footprints only add outlines (including house-scale ones); extrusions replace them.
  hide('building');
  hide('road_oneway');
  hide('road_oneway_opposite');

  // Minor road names off; major ones kept, dimmed.
  if (map.getLayer('highway_name_other')) {
    map.setFilter('highway_name_other', [
      'all',
      ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
      ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false],
    ]);
    set('highway_name_other', 'text-color', '#5c5d63');
    set('highway_name_other', 'text-halo-color', GROUND);
  }

  // Light from one side and fairly high: roofs brighter than walls, adjacent walls differ.
  map.setLight({ anchor: 'map', position: [1.4, 215, 35], color: '#ffffff', intensity: 0.5 });
}

/** Accuracy circles, slate buildings, incident buildings and the badge sync layer: above roads, under labels. */
function addDispatchLayers(map: MapLibreMap, onFrame: (matrix: ArrayLike<number>) => void) {
  // Not simply "before the first symbol": this style puts water labels before the road layers.
  const layers = map.getStyle().layers;
  const lastGround = layers.findLastIndex((l) => l.type !== 'symbol');
  const beforeLabels = layers[lastGround + 1]?.id;

  // Satellite imagery: directly above the background, hidden until satellite mode.
  map.addSource(SAT_SOURCE, { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 16, attribution: SAT_ATTRIBUTION });
  map.addLayer(
    {
      id: 'sp-satellite',
      type: 'raster',
      source: SAT_SOURCE,
      layout: { visibility: 'none' },
      paint: { 'raster-brightness-max': 0.92, 'raster-fade-duration': 150 },
    },
    layers[1]?.id,
  );

  map.addSource(ACCURACY_SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer(
    { id: 'sp-accuracy-fill', type: 'fill', source: ACCURACY_SOURCE, paint: { 'fill-color': '#d4d4d4', 'fill-opacity': 0.1 } },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'sp-accuracy-line',
      type: 'line',
      source: ACCURACY_SOURCE,
      paint: { 'line-color': '#d4d4d4', 'line-opacity': 0.55, 'line-width': 1, 'line-dasharray': [2, 2] },
    },
    beforeLabels,
  );

  map.addLayer(
    {
      id: 'sp-buildings-3d',
      type: 'fill-extrusion',
      source: VECTOR_SOURCE,
      'source-layer': 'building',
      minzoom: 13,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': SLATE,
        'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-base': ['get', 'render_min_height'],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    beforeLabels,
  );

  // Satellite mode: neutral buildings are a thin outline over the photo, plus an invisible fill
  // so hover can still hit-test their footprints.
  map.addLayer(
    {
      id: 'sp-buildings-flat',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'building',
      minzoom: 13,
      filter: ['!', ['has', 'hide_3d']],
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.01 },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'sp-buildings-outline',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!', ['has', 'hide_3d']],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 0.75 },
    },
    beforeLabels,
  );

  map.addSource(INCIDENT_BUILDINGS_SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: 'sp-incident-outline',
      type: 'line',
      source: INCIDENT_BUILDINGS_SOURCE,
      filter: ['all', ['==', ['get', 'kind'], 'outline'], ['==', ['get', 'state'], 'selected']],
      paint: { 'line-color': ACCENT, 'line-width': 3 },
    },
    beforeLabels,
  );
  // fill-extrusion-opacity can't be data-driven, so one layer per state.
  for (const [state, opacity] of Object.entries(INCIDENT_OPACITY['3d'])) {
    map.addLayer(
      {
        id: `sp-incident-${state}`,
        type: 'fill-extrusion',
        source: INCIDENT_BUILDINGS_SOURCE,
        filter: ['all', ['==', ['get', 'kind'], 'part'], ['==', ['get', 'state'], state]],
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': opacity,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      beforeLabels,
    );
  }

  // Hovered building: a faint white shell just outside it, which lightens slate and colour alike.
  map.addSource(HOVER_SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: 'sp-hover',
      type: 'fill-extrusion',
      source: HOVER_SOURCE,
      paint: {
        'fill-extrusion-color': '#ffffff',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-opacity': 0.18,
      },
    },
    beforeLabels,
  );

  // Draws nothing: receives the camera matrix each frame so HTML badges can sit on roofs.
  map.addLayer({
    id: 'sp-badge-sync',
    type: 'custom',
    renderingMode: '2d',
    render: (_gl, args) => onFrame(args.modelViewProjectionMatrix),
  });
}

/** Incident building opacity per state and mode (satellite: semi-transparent so the roof shows). */
const INCIDENT_OPACITY: Record<MapMode, Record<'ack' | 'open' | 'selected', number>> = {
  '3d': { ack: 0.45, open: 0.82, selected: 1 },
  sat: { ack: 0.35, open: 0.55, selected: 0.55 },
};

/** Symbol layers kept in satellite mode: major road names, with a dark halo for photos. */
const SAT_LABELS = ['highway_name_other', 'highway_name_motorway'];

/**
 * Switches basemap styling between the dark 3D view and satellite imagery by toggling
 * visibility and a few paint values. It records the original state once, so switching is
 * idempotent and never adds or removes layers or sources.
 */
function createModeStyler(map: MapLibreMap) {
  // Paint values are saved and restored as-is, so a loosely typed setter is enough here.
  const setPaint = map.setPaintProperty.bind(map) as (layer: string, name: string, value: unknown) => void;
  const visible = (id: string) => map.getLayoutProperty(id, 'visibility') !== 'none';
  const original = map.getStyle().layers.filter((l) => !l.id.startsWith('sp-') && l.type !== 'background');
  // Basemap layers visible in 3D that satellite mode hides (and restores).
  const toHide = original.filter((l) => visible(l.id) && !SAT_LABELS.includes(l.id)).map((l) => l.id);
  const labelPaint = SAT_LABELS.filter((id) => map.getLayer(id)).map((id) => ({
    id,
    color: map.getPaintProperty(id, 'text-color'),
    halo: map.getPaintProperty(id, 'text-halo-color'),
    haloWidth: map.getPaintProperty(id, 'text-halo-width'),
  }));
  const setVisible = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  };

  return (mode: MapMode) => {
    const sat = mode === 'sat';
    setVisible('sp-satellite', sat);
    for (const id of toHide) setVisible(id, !sat);
    setVisible('sp-buildings-3d', !sat);
    setVisible('sp-buildings-flat', sat);
    setVisible('sp-buildings-outline', sat);
    for (const l of labelPaint) {
      setPaint(l.id, 'text-color', sat ? '#f5f5f5' : l.color);
      setPaint(l.id, 'text-halo-color', sat ? 'rgba(0,0,0,0.85)' : l.halo);
      setPaint(l.id, 'text-halo-width', sat ? 1.6 : l.haloWidth);
    }
    for (const [state, opacity] of Object.entries(INCIDENT_OPACITY[mode])) {
      map.setPaintProperty(`sp-incident-${state}`, 'fill-extrusion-opacity', opacity);
    }
  };
}

/** Severity square with optional caller count; a leader line when it floats above a roof. */
function createBadge(group: SceneGroup, selectedId: string | null, onSelect: (id: string) => void): HTMLElement {
  const primary = group.incidents[0];
  const t = tierStyle(primary.severityScore);
  const selected = group.incidents.some((i) => i._id === selectedId);

  const root = document.createElement('div');
  root.className = 'absolute top-0 left-0 flex flex-col items-center';
  root.style.zIndex = String(selected ? 1000 : primary.severityScore * 10 + group.incidents.length);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `group pointer-events-auto relative flex cursor-pointer items-stretch rounded-[2px] ${
    selected ? 'outline-2 outline-offset-2 outline-sky-400' : 'outline-1 outline-black/70'
  } group-data-[mode=sat]/map:bg-black/80 group-data-[mode=sat]/map:p-[2px]`;
  button.setAttribute(
    'aria-label',
    `${incidentNumber(primary._id)} ${typeLabel(primary)}, severity ${primary.severityScore}` +
      (group.incidents.length > 1 ? `, ${group.incidents.length} callers` : ''),
  );
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelect(primary._id);
  });

  const square = document.createElement('span');
  square.className = `flex h-5 min-w-5 items-center justify-center rounded-[2px] px-1 text-[11px] font-semibold ${MONO} ${t.square} ${t.pulse}`;
  square.textContent = String(primary.severityScore);
  button.appendChild(square);

  if (group.incidents.length > 1) {
    const count = document.createElement('span');
    count.className = `flex items-center rounded-r-[2px] bg-[#121213] px-1 text-[11px] text-neutral-200 ${MONO}`;
    count.textContent = `·${group.incidents.length}`;
    button.appendChild(count);
  }

  // Hover tooltip, built with textContent since names come from incident data.
  const tip = document.createElement('span');
  tip.className =
    'pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-[2px] border border-neutral-700 bg-[#121213] px-2 py-1 text-left text-[12px] group-hover:block';
  const line1 = document.createElement('span');
  line1.className = 'block';
  const id = document.createElement('span');
  id.className = `${MONO} text-neutral-400`;
  id.textContent = `${incidentNumber(primary._id)} `;
  const type = document.createElement('span');
  type.className = 'font-medium text-neutral-100';
  type.textContent = typeLabel(primary);
  line1.append(id, type);
  const line2 = document.createElement('span');
  line2.className = 'block text-neutral-400';
  line2.textContent = primary.building?.name ?? 'Unknown location';
  tip.append(line1, line2);
  button.appendChild(tip);

  root.appendChild(button);
  if (group.footprint) {
    const leader = document.createElement('span');
    leader.className =
      'block h-7 w-px bg-neutral-300/70 group-data-[mode=sat]/map:w-[3px] group-data-[mode=sat]/map:border-x group-data-[mode=sat]/map:border-black/80 group-data-[mode=sat]/map:bg-white';
    root.appendChild(leader);
  }
  return root;
}

/** Two-state "3D" / "SAT" toggle, styled like the Overview control. Shortcut: M. */
class ModeControl implements IControl {
  private container: HTMLDivElement | null = null;
  private buttons = new Map<MapMode, HTMLButtonElement>();
  constructor(private readonly onChange: (mode: MapMode) => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group flex!';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Map view (M)');
    for (const [mode, label] of [['3d', '3D'], ['sat', 'SAT']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = mode === 'sat' ? 'Satellite imagery (M)' : 'Dark 3D view (M)';
      button.setAttribute('aria-keyshortcuts', 'M');
      button.addEventListener('click', () => this.onChange(mode));
      container.appendChild(button);
      this.buttons.set(mode, button);
    }
    this.container = container;
    this.setMode(sessionMode);
    return container;
  }

  setMode(mode: MapMode): void {
    for (const [m, button] of this.buttons) {
      const active = m === mode;
      button.setAttribute('aria-pressed', String(active));
      // MapLibre stacks group buttons with a top border; side by side they need a left one.
      button.className = `w-auto! px-2! text-[11px] font-medium tracking-[0.06em] uppercase [&+button]:border-t-0! [&+button]:border-l! [&+button]:border-neutral-800! ${
        active ? 'text-sky-400!' : 'text-neutral-500!'
      }`;
    }
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.buttons.clear();
  }
}

/** "Overview" button that returns the camera to the initial framing. */
class OverviewControl implements IControl {
  private container: HTMLDivElement | null = null;
  constructor(private readonly onClick: () => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'w-auto! px-2! text-[11px] font-medium tracking-[0.06em] text-neutral-300! uppercase';
    button.textContent = 'Overview';
    button.title = 'Return to overview';
    button.addEventListener('click', this.onClick);
    container.appendChild(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}
