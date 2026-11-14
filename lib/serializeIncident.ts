import type {
  CrisisType,
  Incident,
  IceProfile,
  TimelineEntry,
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
};

type LeanIncident = {
  _id: { toString(): string } | string;
  userId: string;
  sessionId?: string | null;
  crisisType: CrisisType | string;
  severityScore: number;
  dispatcherBrief: string;
  sceneSummary?: string | null;
  gps?: { lat: number; lng: number } | null;
  building?: Incident["building"];
  iceProfile?: LeanIce;
  lowBandwidth?: boolean | null;
  classificationFailed?: boolean | null;
  simulated?: boolean | null;
  victimInstructions?: string | null;
  status: Incident["status"] | string;
  lastSeenAt?: Date | string | null;
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
  }));
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
    ...(doc.gps ? { gps: { lat: doc.gps.lat, lng: doc.gps.lng } } : {}),
    ...(doc.building ? { building: doc.building } : {}),
    iceProfile: serializeIce(doc.iceProfile ?? null),
    lowBandwidth: Boolean(doc.lowBandwidth),
    classificationFailed: Boolean(doc.classificationFailed),
    simulated: Boolean(doc.simulated),
    victimInstructions:
      doc.victimInstructions ||
      VICTIM_INSTRUCTIONS[crisisType] ||
      VICTIM_INSTRUCTIONS.UNKNOWN,
    status,
    dispatcherStatus: statusToDispatcherStatus(status),
    ...(doc.lastSeenAt ? { lastSeenAt: toIso(doc.lastSeenAt) } : {}),
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
