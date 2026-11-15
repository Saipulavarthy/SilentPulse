import type { Building, CrisisType, IncidentStatus } from './incident';

/** Where a plan item came from. Every risk and action must name one that exists in the input. */
export const PLAN_SOURCES = [
  'buildingNotes',
  'callerProfile',
  /** Stealth mode on the caller's phone (active threats). */
  'callerDevice',
  'perception',
  'triage',
  'timeline',
  'otherCallers',
] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export type PlanItem = { text: string; source: PlanSource };

/** A dispatcher's working notes for one incident. */
export type ResponsePlan = {
  /** At most 2 plain spoken sentences to read over the radio. */
  radioBrief: string;
  /**
   * One line on all open incidents in the building plus this incident's timeline. Computed in
   * code from the input (not by the model). Absent with one caller and one update.
   */
  situation?: string;
  /** At most 3, most important first. */
  risks: PlanItem[];
  /** At most 3, in order, imperative. */
  actions: PlanItem[];
  /** At most 4 short questions, most important first. */
  unknowns: string[];
};

// ---- input -------------------------------------------------------------------------------------
// Mirrors the fields of `Incident` on main that the plan uses, loosely enough that both the
// current dashboard Incident and main's Incident are assignable (main makes gps optional,
// iceProfile nullable and medications optional).

export type Trend = 'new' | 'worsening' | 'stable' | 'improving';

export type PlanTimelineEntry = {
  ts: string;
  crisisType: CrisisType;
  severityScore: number;
  gps?: { lat: number; lng: number } | null;
  lowBandwidth: boolean;
  classificationFailed: boolean;
  sceneSummary?: string;
};

export type PlanIceProfile = {
  age?: number;
  conditions: string[];
  allergies: string[];
  medications?: string[];
  mobilityNotes?: string;
  sensoryNotes?: string;
};

export type PlanIncident = {
  _id: string;
  crisisType: CrisisType;
  severityScore: number;
  status: IncidentStatus;
  dispatcherBrief: string;
  sceneSummary?: string;
  /** Gemini perception cues. */
  cues?: string[];
  /** Grok evidence → risk reasons. */
  reasons?: string[];
  trend?: Trend;
  gps?: { lat: number; lng: number; accuracy?: number; altitude?: number };
  building?: Building;
  iceProfile: PlanIceProfile | null;
  lowBandwidth: boolean;
  classificationFailed?: boolean;
  /** Signal loss on a live session. */
  escalated?: boolean;
  escalationReason?: string;
  lastSeenAt?: string;
  updateCount?: number;
  timeline?: PlanTimelineEntry[];
  /** Victim quick-action selection from the phone crisis UI. */
  userProvidedContext?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlanBuilding = {
  name: string;
  type: string;
  floors: number;
  notes?: string;
};

/** GPS uncertainty → building match quality for the plan. */
export type PlanLocationConfidence = 'single' | 'multiple' | 'none' | 'confirmed';

/** Another open incident whose accuracy range overlaps these buildings. */
export type OtherCaller = {
  crisisType: CrisisType;
  severityScore: number;
  status: IncidentStatus;
  createdAt: string;
  summary: string;
};

/** POST /api/response-plan body. */
export type PlanRequest = {
  incident: PlanIncident;
  /**
   * Primary building for notes (single or confirmed only). Null when outdoors or
   * multiple candidates — use buildingsInRange instead.
   */
  building: PlanBuilding | null;
  /** Every campus building intersecting the GPS uncertainty circle, best overlap first. */
  buildingsInRange?: PlanBuilding[];
  locationConfidence?: PlanLocationConfidence;
  otherCallers: OtherCaller[];
};

export type PlanErrorCode = 'bad_request' | 'missing_key' | 'rate_limited' | 'timeout' | 'invalid_output' | 'upstream';

export type PlanResponse =
  | {
      ok: true;
      plan: ResponsePlan;
      model: string;
      generatedAt: string;
      /** Items cut to the word limit. */
      shortened: number;
      /** Items dropped by validation, with why (unknown source, generic, stealth, over the limit). */
      dropped: string[];
    }
  | { ok: false; error: PlanErrorCode; message: string };
