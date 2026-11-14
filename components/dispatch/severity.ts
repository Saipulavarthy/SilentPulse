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
 * Short display number derived from `_id`: trailing digits if it has them
 * (mock-007 → SP-0007), otherwise the low 4 decimal digits of the last 6 hex
 * chars (the counter part of a Mongo ObjectId).
 */
export function incidentNumber(id: string): string {
  const digits = id.match(/(\d+)$/)?.[1];
  const n = digits ? Number(digits) : parseInt(id.slice(-6), 16) || 0;
  return `SP-${String(n % 10000).padStart(4, '0')}`;
}

/** Severity descending, then newest first. */
export function sortIncidents(incidents: Incident[]): Incident[] {
  return [...incidents].sort(
    (a, b) =>
      b.severityScore - a.severityScore ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export type QueueFilter = 'open' | 'acknowledged' | 'resolved' | 'all';

export const FILTERS: { key: QueueFilter; label: string; status?: IncidentStatus }[] = [
  { key: 'open', label: 'Open', status: 'ACTIVE' },
  { key: 'acknowledged', label: 'Acknowledged', status: 'ACKNOWLEDGED' },
  { key: 'resolved', label: 'Resolved', status: 'RESOLVED' },
  { key: 'all', label: 'All' },
];

export function applyFilter(incidents: Incident[], filter: QueueFilter): Incident[] {
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
  if (i.gps.altitude === undefined || ground === undefined || !i.building) return null;
  const floors = Math.max(1, i.building.floors);
  const clamp = (n: number) => Math.min(floors, Math.max(1, n));
  const est = Math.floor((i.gps.altitude - ground) / FLOOR_HEIGHT_M) + 1;
  return [clamp(est - 1), clamp(est + 1)];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Elapsed since `iso` as mm:ss, or h:mm:ss past an hour. */
export function elapsed(iso: string, now: number | null): string {
  if (now === null) return '--:--';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
