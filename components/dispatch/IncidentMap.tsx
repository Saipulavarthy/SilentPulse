'use client';

import 'leaflet/dist/leaflet.css';
import { divIcon, type LatLngBoundsExpression } from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { Incident } from '@/types/incident';
// Plain CSS (prefixed .sp-map): the project's Turbopack *.css rule doesn't support CSS Modules.
import './incident-map.css';
import type { MapPanelProps } from './MapPanel';
import { incidentNumber, tierStyle, typeLabel } from './severity';
import { MONO } from './ui';

const UMASS_CENTER: [number, number] = [42.389, -72.527];
const FALLBACK_ZOOM = 16;
const MARKER_SIZE = 20;

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const isDrawn = (i: Incident) => i.status !== 'RESOLVED';

export default function IncidentMap({ incidents, selectedId, onSelect }: MapPanelProps) {
  const drawn = incidents.filter(isDrawn);
  const selected = drawn.find((i) => i._id === selectedId) ?? null;

  // Frame the open incidents once, on load. MapContainer ignores later changes to `bounds`.
  const [initialBounds] = useState<LatLngBoundsExpression | undefined>(() =>
    drawn.length ? drawn.map((i) => [i.gps.lat, i.gps.lng] as [number, number]) : undefined,
  );

  return (
    <MapContainer
      className="sp-map absolute inset-0 h-full w-full"
      {...(initialBounds
        ? { bounds: initialBounds, boundsOptions: { padding: [56, 56], maxZoom: 17 } }
        : { center: UMASS_CENTER, zoom: FALLBACK_ZOOM })}
    >
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />

      {drawn.map((incident) => (
        <IncidentMarker
          key={incident._id}
          incident={incident}
          selected={incident._id === selectedId}
          onSelect={onSelect}
        />
      ))}

      <KeepSelectedInView incident={selected} />
      <InvalidateOnResize />
    </MapContainer>
  );
}

function IncidentMarker({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = tierStyle(incident.severityScore);
  const icon = useMemo(
    () =>
      divIcon({
        className: '',
        iconSize: [MARKER_SIZE, MARKER_SIZE],
        iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
        html: `<div class="flex h-5 w-5 items-center justify-center rounded-[2px] text-[11px] font-semibold ${MONO} ${t.square} ${
          selected ? 'outline-2 outline-offset-2 outline-sky-400' : 'outline-1 outline-black/70'
        } ${t.pulse}">${incident.severityScore}</div>`,
      }),
    [incident.severityScore, selected, t],
  );

  return (
    <Marker
      position={[incident.gps.lat, incident.gps.lng]}
      icon={icon}
      // Higher severity draws on top; the selected marker above everything.
      zIndexOffset={(selected ? 10_000 : 0) + incident.severityScore * 100}
      title={`${incidentNumber(incident._id)} ${typeLabel(incident)}`}
      eventHandlers={{ click: () => onSelect(incident._id) }}
    >
      <Tooltip direction="top" offset={[0, -MARKER_SIZE / 2 - 2]}>
        <span className={`${MONO} text-neutral-400`}>{incidentNumber(incident._id)}</span>{' '}
        <span className="font-medium text-neutral-100">{typeLabel(incident)}</span>
        <br />
        <span className="text-neutral-400">{incident.building?.name ?? 'Unknown location'}</span>
      </Tooltip>
    </Marker>
  );
}

/** Pans only when the selected marker is outside the comfortable middle of the view. */
function KeepSelectedInView({ incident }: { incident: Incident | null }) {
  const map = useMap();
  const lat = incident?.gps.lat;
  const lng = incident?.gps.lng;

  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    const inner = map.getBounds().pad(-0.12);
    if (!inner.contains([lat, lng])) map.panTo([lat, lng], { animate: true, duration: 0.5 });
  }, [map, lat, lng]);

  return null;
}

/** Keeps Leaflet's size in sync with its grid column. */
function InvalidateOnResize() {
  const map = useMap();

  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);

  return null;
}
