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
import type { Incident } from '@/types/incident';
import type { MapPanelProps } from './MapPanel';
import {
  circlePolygon,
  findFootprints,
  groupIncidents,
  inflate,
  isDrawn,
  projectWithAltitude,
  type BuildingFeature,
  type Footprint,
  type SceneGroup,
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

const ACCURACY_SOURCE = 'sp-accuracy';
const INCIDENT_BUILDINGS_SOURCE = 'sp-incident-buildings';
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

export default function IncidentMap({ incidents, selectedId, onSelect }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const footprintsRef = useRef(new Map<string, Footprint | null>());
  const badgesRef = useRef<Badge[]>([]);
  const matrixRef = useRef<ArrayLike<number> | null>(null);
  const lastFlownRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [initialDrawn] = useState(() => incidents.filter(isDrawn));

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
    const features = map.querySourceFeatures(VECTOR_SOURCE, { sourceLayer: 'building' }) as BuildingFeature[];
    const view = map.getBounds();
    const isInView = (lng: number, lat: number) => map.getZoom() >= 13 && view.contains([lng, lat]);
    const next = findFootprints(features, incidents.filter(isDrawn), isInView, footprintsRef.current);
    const signature = (m: Map<string, Footprint | null>) =>
      [...m].map(([id, f]) => `${id}=${f ? `${f.key}@${f.roofHeight}/${f.parts.length}` : '-'}`).sort().join('|');
    if (signature(next) === signature(footprintsRef.current)) return;
    footprintsRef.current = next;
    renderScene();
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
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new OverviewControl(() => map.flyTo({ ...overview, duration: 1200 })), 'top-left');

    map.on('load', () => {
      restyleBase(map);
      addDispatchLayers(map, positionBadges);
      setReady(true);
    });
    // Tiles finished loading after a camera move: footprints may now be available.
    map.on('idle', () => lookupFootprints());

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [initialDrawn]);

  useEffect(() => {
    if (ready) lookupFootprints();
  }, [ready, incidents]);

  useEffect(() => {
    if (ready) renderScene();
  }, [ready, incidents, selectedId]);

  // Fly to the selected incident (not on first load, which keeps the overview).
  const selected = incidents.find((i) => i._id === selectedId && isDrawn(i));
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
    map.flyTo({ center: [lng, lat], zoom: SELECTED_ZOOM, pitch: PITCH, bearing: map.getBearing(), duration: 1400 });
  }, [ready, selectedId, lat, lng]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className={`h-full w-full bg-[#16171a] ${MAP_CHROME}`} />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" />
    </div>
  );
}

/**
 * Frames the open incidents: centre on their middle (so they sit mid-panel at any pitch),
 * zoom to fit but never further out than MIN_OVERVIEW_ZOOM.
 */
function overviewCamera(map: MapLibreMap, incidents: Incident[]): JumpToOptions {
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
  for (const [state, opacity] of [
    ['ack', 0.45],
    ['open', 0.82],
    ['selected', 1],
  ] as const) {
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

  // Draws nothing: receives the camera matrix each frame so HTML badges can sit on roofs.
  map.addLayer({
    id: 'sp-badge-sync',
    type: 'custom',
    renderingMode: '2d',
    render: (_gl, args) => onFrame(args.modelViewProjectionMatrix),
  });
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
  }`;
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
    leader.className = 'block h-7 w-px bg-neutral-300/70';
    root.appendChild(leader);
  }
  return root;
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
    button.className = 'w-auto! px-2 text-[11px] font-medium tracking-[0.06em] text-neutral-300! uppercase';
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
