import type {
  CrisisType,
  Incident,
  IceProfile,
  TimelineEntry,
  Trend,
} from "@/types/incident";
import {
  statusToDispatcherStatus,
  VICTIM_INSTRUCTIONS,
} from "@/types/incident";

type LeanIce = {
  name?: string | null;
  age?: number | null;
  bloodType?: string | null;
  allergies?: string[] | null;
  conditions?: string[] | null;
  medications?: string[] | null;
  emergencyContact?: {
    name?: string | null;
    phone?: string | null;
    relation?: string | null;
  } | null;
  mobilityNotes?: string | null;
  sensoryNotes?: string | null;
} | null;

type LeanTimelineEntry = {
  ts?: Date | string;
  crisisType: CrisisType | string;
  severityScore: number;
  gps?: { lat: number; lng: number } | null;
  lowBandwidth?: boolean | null;
  classificationFailed?: boolean | null;
  sceneSummary?: string | null;
};

type LeanIncident = {
  _id: { toString(): string } | string;
  userId: string;
  sessionId?: string | null;
  crisisType: CrisisType | string;
  severityScore: number;
  dispatcherBrief: string;
  sceneSummary?: string | null;
  cues?: string[] | null;
  reasons?: string[] | null;
  trend?: Trend | string | null;
  gps?: {
    lat: number;
    lng: number;
    accuracy?: number | null;
    altitude?: number | null;
  } | null;
  building?: {
    name: string;
    type: string;
    floors: number;
    notes?: string | null;
  } | null;
  iceProfile?: LeanIce;
  lowBandwidth?: boolean | null;
  classificationFailed?: boolean | null;
  simulated?: boolean | null;
  victimInstructions?: string | string[] | null;
  status: Incident["status"] | string;
  dispatcherMessage?: {
    text?: string | null;
    sentAt?: Date | string | null;
    seenAt?: Date | string | null;
  } | null;
  userProvidedContext?: string | null;
  lastSeenAt?: Date | string | null;
  escalated?: boolean | null;
  escalationReason?: string | null;
  updateCount?: number | null;
  timeline?: LeanTimelineEntry[] | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

function serializeIce(ice: LeanIce): IceProfile | null {
  if (!ice) return null;
  return {
    ...(ice.name ? { name: ice.name } : {}),
    ...(typeof ice.age === "number" ? { age: ice.age } : {}),
    ...(ice.bloodType ? { bloodType: ice.bloodType } : {}),
    allergies: ice.allergies ?? [],
    conditions: ice.conditions ?? [],
    medications: ice.medications ?? [],
    ...(ice.mobilityNotes ? { mobilityNotes: ice.mobilityNotes } : {}),
    ...(ice.sensoryNotes ? { sensoryNotes: ice.sensoryNotes } : {}),
    ...(ice.emergencyContact
      ? {
          emergencyContact: {
            ...(ice.emergencyContact.name
              ? { name: ice.emergencyContact.name }
              : {}),
            ...(ice.emergencyContact.phone
              ? { phone: ice.emergencyContact.phone }
              : {}),
            ...(ice.emergencyContact.relation
              ? { relation: ice.emergencyContact.relation }
              : {}),
          },
        }
      : {}),
  };
}

function toIso(value: Date | string | undefined | null): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function serializeTimeline(
  entries: LeanTimelineEntry[] | null | undefined,
): TimelineEntry[] | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.map((e) => ({
    ts: toIso(e.ts),
    crisisType: e.crisisType as CrisisType,
    severityScore: e.severityScore,
    gps: e.gps ? { lat: e.gps.lat, lng: e.gps.lng } : null,
    lowBandwidth: Boolean(e.lowBandwidth),
    classificationFailed: Boolean(e.classificationFailed),
    ...(e.sceneSummary ? { sceneSummary: e.sceneSummary } : {}),
  }));
}

function serializeVictimInstructions(
  value: string | string[] | null | undefined,
  crisisType: CrisisType,
): string | string[] {
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    if (cleaned.length > 0) return cleaned;
  } else if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return (
    VICTIM_INSTRUCTIONS[crisisType] || VICTIM_INSTRUCTIONS.UNKNOWN
  );
}

/** Map a Mongo lean/hydrated ActiveIncident into the shared API Incident contract. */
export function serializeIncident(doc: LeanIncident): Incident {
  const crisisType = doc.crisisType as CrisisType;
  const status = doc.status as Incident["status"];
  return {
    _id: typeof doc._id === "string" ? doc._id : doc._id.toString(),
    userId: doc.userId,
    ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
    crisisType,
    severityScore: doc.severityScore,
    dispatcherBrief: doc.dispatcherBrief,
    ...(doc.sceneSummary ? { sceneSummary: doc.sceneSummary } : {}),
    cues: Array.isArray(doc.cues) ? doc.cues : [],
    reasons: Array.isArray(doc.reasons) ? doc.reasons : [],
    trend: (doc.trend as Trend) || "new",
    ...(doc.gps
      ? {
          gps: {
            lat: doc.gps.lat,
            lng: doc.gps.lng,
            ...(typeof doc.gps.accuracy === "number"
              ? { accuracy: doc.gps.accuracy }
              : {}),
            ...(typeof doc.gps.altitude === "number"
              ? { altitude: doc.gps.altitude }
              : {}),
          },
        }
      : {}),
    ...(doc.building
      ? {
          building: {
            name: doc.building.name,
            type: doc.building.type,
            floors: doc.building.floors,
            ...(doc.building.notes
              ? { notes: doc.building.notes }
              : {}),
          },
        }
      : {}),
    iceProfile: serializeIce(doc.iceProfile ?? null),
    lowBandwidth: Boolean(doc.lowBandwidth),
    classificationFailed: Boolean(doc.classificationFailed),
    simulated: Boolean(doc.simulated),
    victimInstructions: serializeVictimInstructions(
      doc.victimInstructions,
      crisisType,
    ),
    status,
    dispatcherStatus: statusToDispatcherStatus(status),
    ...(doc.dispatcherMessage?.text && doc.dispatcherMessage.sentAt
      ? {
          dispatcherMessage: {
            text: doc.dispatcherMessage.text,
            sentAt: toIso(doc.dispatcherMessage.sentAt),
            ...(doc.dispatcherMessage.seenAt
              ? { seenAt: toIso(doc.dispatcherMessage.seenAt) }
              : {}),
          },
        }
      : {}),
    ...(doc.userProvidedContext
      ? { userProvidedContext: doc.userProvidedContext }
      : {}),
    ...(doc.lastSeenAt ? { lastSeenAt: toIso(doc.lastSeenAt) } : {}),
    escalated: Boolean(doc.escalated),
    ...(doc.escalationReason
      ? { escalationReason: doc.escalationReason }
      : {}),
    ...(typeof doc.updateCount === "number"
      ? { updateCount: doc.updateCount }
      : {}),
    ...(serializeTimeline(doc.timeline)
      ? { timeline: serializeTimeline(doc.timeline) }
      : {}),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}
