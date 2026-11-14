import { landmarkAt } from '@/lib/landmarks';
import {
  severityTier,
  type CrisisType,
  type Incident,
  type IncidentStatus,
  type SeverityTier,
} from '@/types/incident';

export const TIERS: SeverityTier[] = ['lethal', 'critical', 'urgent', 'low'];

/**
 * Severity colour lives only here and is used only on severity elements:
 * the solid score square, the 3px row edge and map markers.
 */
export const TIER_STYLES: Record<
  SeverityTier,
  {
    label: string;
    square: string;
    edge: string;
    pulse: string;
    response: string;
    /** Same colour as `square`, as hex for MapLibre paint properties. */
    hex: string;
  }
> = {
  lethal: {
    label: 'Lethal',
    hex: '#dc2626',
    square: 'bg-red-600 text-white',
    edge: 'border-l-red-600',
    pulse: 'motion-safe:animate-pulse',
    response: 'Police tactical response, live GPS',
  },
  critical: {
    label: 'Critical',
    hex: '#f97316',
    square: 'bg-orange-500 text-black',
    edge: 'border-l-orange-500',
    pulse: '',
    response: 'Multi-unit Fire / Paramedic',
  },
  urgent: {
    label: 'Urgent',
    hex: '#facc15',
    square: 'bg-yellow-400 text-black',
    edge: 'border-l-yellow-400',
    pulse: '',
    response: 'Single EMS unit, wellness check',
  },
  low: {
    label: 'Low',
    hex: '#16a34a',
    square: 'bg-green-600 text-white',
    edge: 'border-l-green-600',
    pulse: '',
    response: 'Possible false alarm, flag for review, no dispatch',
  },
};

export function tierStyle(score: number) {
  return TIER_STYLES[severityTier(score)];
}

export const isReview = (i: Incident) => severityTier(i.severityScore) === 'low';

const CRISIS_LABELS: Record<CrisisType, string> = {
  ENVIRONMENTAL_HAZARD: 'Environmental Hazard',
  MEDICAL_CRISIS: 'Medical Crisis',
  ACTIVE_THREAT: 'Active Threat',
  UNKNOWN: 'Unknown',
};

/** Low-bandwidth SOS has no classification, so it is labelled by how it arrived. */
export function typeLabel(i: Incident): string {
  return i.lowBandwidth ? 'Low-Bandwidth SOS' : CRISIS_LABELS[i.crisisType];
}

export const STATUS_SHORT: Record<IncidentStatus, string> = {
  ACTIVE: 'OPEN',
  ACKNOWLEDGED: 'ACK',
  RESOLVED: 'RES',
};

export const STATUS_LONG: Record<IncidentStatus, string> = {
  ACTIVE: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

/**
 * Short, stable display id. Mock ids keep their number (mock-007 → SP-0007). Anything else
 * (a Mongo ObjectId) is hashed whole with FNV-1a into 31 bits, written as 6 base-36 chars:
 * it never depends on list position, and among 50 incidents the chance of any collision is
 * about 1 in 1.7 million (trailing digits or the ObjectId counter alone could collide).
 */
export function incidentNumber(id: string): string {
  const mock = id.match(/^mock-(\d+)$/)?.[1];
  if (mock) return `SP-${mock.padStart(4, '0')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `SP-${(h & 0x7fffffff).toString(36).toUpperCase().padStart(6, '0')}`;
}

const timeOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Same order as GET /api/incidents: escalated first, then severity, then newest. */
export function sortIncidents<T extends Incident>(incidents: T[]): T[] {
  return [...incidents].sort(
    (a, b) =>
      Number(Boolean(b.escalated)) - Number(Boolean(a.escalated)) ||
      b.severityScore - a.severityScore ||
      timeOf(b.createdAt) - timeOf(a.createdAt) ||
      a._id.localeCompare(b._id),
  );
}

/** Where the incident is, for the queue: backend building, else OSM name at the GPS point. */
export function locationLabel(i: Incident): string {
  if (i.building?.name) return i.building.name;
  if (!i.gps) return 'No location';
  return landmarkAt(i.gps.lng, i.gps.lat)?.name ?? 'Unknown building';
}

export type QueueFilter = 'open' | 'acknowledged' | 'resolved' | 'all';

export const FILTERS: { key: QueueFilter; label: string; status?: IncidentStatus }[] = [
  { key: 'open', label: 'Open', status: 'ACTIVE' },
  { key: 'acknowledged', label: 'Acknowledged', status: 'ACKNOWLEDGED' },
  { key: 'resolved', label: 'Resolved', status: 'RESOLVED' },
  { key: 'all', label: 'All' },
];

export function applyFilter<T extends Incident>(incidents: T[], filter: QueueFilter): T[] {
  const status = FILTERS.find((f) => f.key === filter)?.status;
  return sortIncidents(status ? incidents.filter((i) => i.status === status) : incidents);
}

const FLOOR_HEIGHT_M = 4;

/**
 * Rough floor range from GPS altitude above the building's ground elevation:
 * floor(Δ / 4 m) + 1 (ground floor = 1), ±1 floor, clamped to 1..building.floors.
 * Null unless altitude, ground elevation and building are all present.
 */
export function estimateFloorRange(i: Incident): [number, number] | null {
  const ground = i.building?.groundElevationM;
  const altitude = i.gps?.altitude;
  if (altitude === undefined || ground === undefined || !i.building || i.building.floors < 1) return null;
  const floors = i.building.floors;
  const clamp = (n: number) => Math.min(floors, Math.max(1, n));
  const est = Math.floor((altitude - ground) / FLOOR_HEIGHT_M) + 1;
  return [clamp(est - 1), clamp(est + 1)];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Elapsed since `iso` as mm:ss, or h:mm:ss past an hour. "—" when the time is unknown. */
export function elapsed(iso: string, now: number | null): string {
  if (now === null) return '--:--';
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
