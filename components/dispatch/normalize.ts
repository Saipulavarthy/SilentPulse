// Turns whatever /api/incidents (or a mock) returns into a safe dashboard Incident.
// Nothing here throws: unknown values fall back, and every fix is recorded in `dataIssues`
// so the detail panel can show what was wrong with the incoming record.

import {
  statusToDispatcherStatus,
  type Building,
  type CrisisType,
  type IceProfile,
  type Incident,
  type IncidentStatus,
  type TimelineEntry,
  type Trend,
} from '@/types/incident';
import { CONTACT_CALL_STATUSES, type ContactCall, type ContactCallStatus } from '@/types/contactCall';

export type DashIncident = Incident & {
  /** What normalization had to fix in the incoming record (empty when it was clean). */
  dataIssues: string[];
  /** createdAt could not be parsed; elapsed times are shown as unknown. */
  dateUnknown?: boolean;
};

const CRISIS_TYPES: readonly CrisisType[] = ['ENVIRONMENTAL_HAZARD', 'MEDICAL_CRISIS', 'ACTIVE_THREAT', 'UNKNOWN'];
const STATUSES: readonly IncidentStatus[] = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'];
const TRENDS: readonly Trend[] = ['new', 'worsening', 'stable', 'improving'];
/** Shown when severity is missing entirely: mid-range, so it is neither hidden nor maximal. */
const MISSING_SEVERITY = 5;
export const EPOCH_ISO = new Date(0).toISOString();

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

/** ISO string for a parseable date, otherwise undefined. */
function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' && !(v instanceof Date)) return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function idOf(raw: Raw, index: number): string {
  const id = raw._id;
  if (typeof id === 'string' && id) return id;
  if (isObj(id) && typeof id.$oid === 'string') return id.$oid;
  return `missing-id-${index}`;
}

function gpsOf(v: unknown, issues: string[]): Incident['gps'] {
  if (v === undefined || v === null) return undefined;
  const lat = isObj(v) ? num(v.lat) : undefined;
  const lng = isObj(v) ? num(v.lng) : undefined;
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    issues.push('GPS present but invalid; ignored');
    return undefined;
  }
  const accuracy = isObj(v) ? num(v.accuracy) : undefined;
  const altitude = isObj(v) ? num(v.altitude) : undefined;
  return { lat, lng, ...(accuracy !== undefined && accuracy >= 0 ? { accuracy } : {}), ...(altitude !== undefined ? { altitude } : {}) };
}

function buildingOf(v: unknown): Building | undefined {
  if (!isObj(v) || !str(v.name)) return undefined;
  const floors = num(v.floors);
  const ground = num(v.groundElevationM);
  return {
    name: str(v.name)!,
    type: str(v.type) ?? 'Building',
    floors: floors !== undefined && floors > 0 ? Math.round(floors) : 0,
    ...(str(v.notes) ? { notes: str(v.notes) } : {}),
    ...(ground !== undefined ? { groundElevationM: ground } : {}),
  };
}

function iceOf(v: unknown): IceProfile | null {
  if (!isObj(v)) return null;
  const contact = isObj(v.emergencyContact)
    ? {
        ...(str(v.emergencyContact.name) ? { name: str(v.emergencyContact.name) } : {}),
        ...(str(v.emergencyContact.phone) ? { phone: str(v.emergencyContact.phone) } : {}),
        ...(str(v.emergencyContact.relation) ? { relation: str(v.emergencyContact.relation) } : {}),
      }
    : undefined;
  const age = num(v.age);
  return {
    ...(str(v.name) ? { name: str(v.name) } : {}),
    ...(age !== undefined && age >= 0 ? { age: Math.round(age) } : {}),
    ...(str(v.bloodType) ? { bloodType: str(v.bloodType) } : {}),
    conditions: strList(v.conditions),
    allergies: strList(v.allergies),
    medications: strList(v.medications),
    ...(contact && Object.keys(contact).length ? { emergencyContact: contact } : {}),
    ...(str(v.mobilityNotes) ? { mobilityNotes: str(v.mobilityNotes) } : {}),
    ...(str(v.sensoryNotes) ? { sensoryNotes: str(v.sensoryNotes) } : {}),
  };
}

function severityOf(v: unknown, issues: string[], label = 'Severity'): number {
  const n = num(typeof v === 'string' ? Number(v) : v);
  if (n === undefined) {
    issues.push(`${label} missing; shown as ${MISSING_SEVERITY}`);
    return MISSING_SEVERITY;
  }
  const clamped = Math.min(10, Math.max(1, Math.round(n)));
  if (clamped !== n) issues.push(`${label} ${n} out of range; shown as ${clamped}`);
  return clamped;
}

function crisisOf(v: unknown, issues: string[]): CrisisType {
  if (CRISIS_TYPES.includes(v as CrisisType)) return v as CrisisType;
  issues.push(`Unrecognised crisis type "${String(v)}"; shown as Unknown`);
  return 'UNKNOWN';
}

function timelineOf(v: unknown): TimelineEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const entries = v.flatMap((e): TimelineEntry[] => {
    if (!isObj(e)) return [];
    const ts = iso(e.ts);
    if (!ts) return [];
    const ignore: string[] = [];
    const gps = gpsOf(e.gps, ignore);
    return [
      {
        ts,
        crisisType: CRISIS_TYPES.includes(e.crisisType as CrisisType) ? (e.crisisType as CrisisType) : 'UNKNOWN',
        severityScore: severityOf(e.severityScore, ignore),
        gps: gps ? { lat: gps.lat, lng: gps.lng } : null,
        lowBandwidth: Boolean(e.lowBandwidth),
        classificationFailed: Boolean(e.classificationFailed),
        ...(str(e.sceneSummary) ? { sceneSummary: str(e.sceneSummary) } : {}),
      },
    ];
  });
  return entries.length ? entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) : undefined;
}

function contactCallsOf(v: unknown): ContactCall[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const calls = v.flatMap((c): ContactCall[] => {
    if (!isObj(c) || (c.kind !== 'alert' && c.kind !== 'allClear')) return [];
    const requestedAt = iso(c.requestedAt);
    if (!requestedAt) return [];
    const status = (CONTACT_CALL_STATUSES as readonly string[]).includes(c.status as string) ? (c.status as ContactCallStatus) : 'failed';
    const answeredAt = iso(c.answeredAt);
    return [
      {
        kind: c.kind,
        status,
        to: str(c.to) ?? '',
        script: str(c.script) ?? '',
        ...(c.spoken === 'script' || c.spoken === 'trialTemplate' ? { spoken: c.spoken } : {}),
        callSid: str(c.callSid) ?? '',
        requestedAt,
        updatedAt: iso(c.updatedAt) ?? requestedAt,
        ...(answeredAt ? { answeredAt } : {}),
      },
    ];
  });
  return calls.length ? calls : undefined;
}

/** Never throws; returns null only for values that are not objects at all. */
export function normalizeIncident(value: unknown, index = 0): DashIncident | null {
  if (!isObj(value)) return null;
  const raw = value;
  const issues: string[] = [];

  const crisisType = crisisOf(raw.crisisType, issues);
  const severityScore = severityOf(raw.severityScore, issues);
  let status: IncidentStatus = 'ACTIVE';
  if (STATUSES.includes(raw.status as IncidentStatus)) status = raw.status as IncidentStatus;
  else issues.push(`Unrecognised status "${String(raw.status)}"; shown as open`);

  const createdIso = iso(raw.createdAt) ?? iso(raw.updatedAt) ?? iso(raw.lastSeenAt);
  if (!iso(raw.createdAt)) issues.push(createdIso ? 'createdAt unparseable; using a later timestamp' : 'No parseable timestamps');
  const createdAt = createdIso ?? EPOCH_ISO;
  const updatedAt = iso(raw.updatedAt) ?? createdAt;

  const victim = raw.victimInstructions;
  const victimInstructions = Array.isArray(victim) ? strList(victim) : (str(victim) ?? '');
  const trend = TRENDS.includes(raw.trend as Trend) ? (raw.trend as Trend) : undefined;
  const lastSeenAt = iso(raw.lastSeenAt);
  const updateCount = num(raw.updateCount);
  const gps = gpsOf(raw.gps, issues);
  const building = buildingOf(raw.building);
  const timeline = timelineOf(raw.timeline);
  const contactCalls = contactCallsOf(raw.contactCalls);
  const userProvidedContext = str(raw.userProvidedContext);
  const rawMsg = isObj(raw.dispatcherMessage) ? raw.dispatcherMessage : null;
  const msgText = rawMsg ? str(rawMsg.text) : undefined;
  const msgSentAt = rawMsg ? iso(rawMsg.sentAt) : undefined;
  const msgSeenAt = rawMsg ? iso(rawMsg.seenAt) : undefined;
  const dispatcherMessage =
    msgText && msgSentAt
      ? { text: msgText, sentAt: msgSentAt, ...(msgSeenAt ? { seenAt: msgSeenAt } : {}) }
      : undefined;

  return {
    _id: idOf(raw, index),
    userId: str(raw.userId) ?? '',
    ...(str(raw.sessionId) ? { sessionId: str(raw.sessionId) } : {}),
    crisisType,
    severityScore,
    dispatcherBrief: str(raw.dispatcherBrief) ?? 'No dispatcher brief received.',
    ...(str(raw.sceneSummary) ? { sceneSummary: str(raw.sceneSummary) } : {}),
    cues: strList(raw.cues),
    reasons: strList(raw.reasons),
    ...(trend ? { trend } : {}),
    ...(gps ? { gps } : {}),
    ...(building ? { building } : {}),
    iceProfile: iceOf(raw.iceProfile),
    lowBandwidth: Boolean(raw.lowBandwidth),
    classificationFailed: Boolean(raw.classificationFailed),
    simulated: Boolean(raw.simulated),
    victimInstructions,
    status,
    dispatcherStatus: statusToDispatcherStatus(status),
    ...(dispatcherMessage ? { dispatcherMessage } : {}),
    ...(userProvidedContext ? { userProvidedContext } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    escalated: Boolean(raw.escalated),
    ...(str(raw.escalationReason) ? { escalationReason: str(raw.escalationReason) } : {}),
    ...(updateCount !== undefined ? { updateCount } : {}),
    ...(timeline ? { timeline } : {}),
    ...(contactCalls ? { contactCalls } : {}),
    createdAt,
    updatedAt,
    dataIssues: issues,
    ...(createdIso ? {} : { dateUnknown: true }),
  };
}

/** Normalizes a list, dropping non-objects and de-duplicating by _id (last one wins). */
export function normalizeIncidents(values: unknown): DashIncident[] {
  if (!Array.isArray(values)) return [];
  const byId = new Map<string, DashIncident>();
  values.forEach((v, i) => {
    const n = normalizeIncident(v, i);
    if (n) byId.set(n._id, n);
  });
  return [...byId.values()];
}

/** Incidents with a usable GPS fix (the only ones drawn on the map). */
export function hasGps<T extends Incident>(i: T): i is T & { gps: NonNullable<Incident['gps']> } {
  return i.gps !== undefined && Number.isFinite(i.gps.lat) && Number.isFinite(i.gps.lng);
}
