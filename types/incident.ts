// Shared contract between the triage backend and the dispatcher dashboard.
// Changes here need sign-off from both sides.

/** UNKNOWN = low-bandwidth SOS (no image/audio), so nothing was classified. */
export type CrisisType =
  | "ENVIRONMENTAL_HAZARD"
  | "MEDICAL_CRISIS"
  | "ACTIVE_THREAT"
  | "UNKNOWN";

export type IncidentStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED";

/** Phone telemetry UI status derived from IncidentStatus. */
export type DispatcherStatus = "reviewing" | "dispatched" | "resolved";

/**
 * Normalized ICE shape stored in Mongo / attached to incidents.
 * Includes phone-ICE fields mobilityNotes / sensoryNotes.
 */
export interface IceProfile {
  name?: string;
  age?: number;
  bloodType?: string;
  conditions: string[];
  allergies: string[];
  medications?: string[];
  emergencyContact?: {
    name?: string;
    phone?: string;
    relation?: string;
  };
  mobilityNotes?: string;
  sensoryNotes?: string;
}

export interface Building {
  name: string;
  type: string;
  floors: number;
  notes?: string;
}

export interface Incident {
  _id: string;
  userId: string;
  sessionId?: string;
  crisisType: CrisisType;
  /** Integer 1-10, assigned by Grok. */
  severityScore: number;
  dispatcherBrief: string;
  /** One line on what Gemini saw/heard. Absent for low-bandwidth SOS. */
  sceneSummary?: string;
  /** Optional — phone may omit GPS. */
  gps?: {
    lat: number;
    lng: number;
  };
  building?: Building;
  /** Snapshot of the user's ICE profile at the time of the SOS. */
  iceProfile: IceProfile | null;
  lowBandwidth: boolean;
  /** True when Gemini timed out / failed while media was present. */
  classificationFailed?: boolean;
  /** Static instructions shown to the victim on-device. */
  victimInstructions: string;
  status: IncidentStatus;
  /** Derived for the phone UI (ACTIVE→reviewing, ACKNOWLEDGED→dispatched). */
  dispatcherStatus: DispatcherStatus;
  /** ISO 8601 string. */
  createdAt: string;
  /** ISO 8601 string. */
  updatedAt: string;
}

export function statusToDispatcherStatus(
  status: IncidentStatus,
): DispatcherStatus {
  if (status === "ACKNOWLEDGED") return "dispatched";
  if (status === "RESOLVED") return "resolved";
  return "reviewing";
}

export type SeverityTier = "low" | "urgent" | "critical" | "lethal";

/** 1-3 low, 4-6 urgent, 7-8 critical, 9-10 lethal. Out-of-range scores are clamped. */
export function severityTier(score: number): SeverityTier {
  if (score >= 9) return "lethal";
  if (score >= 7) return "critical";
  if (score >= 4) return "urgent";
  return "low";
}

/** Phone onboarding / localStorage ICE payload (stringly-typed form fields). */
export type PhoneIceProfilePayload = {
  fullName?: string;
  age?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  bloodType?: string;
  medicalConditions?: string;
  allergies?: string;
  mobilityNotes?: string;
  sensoryNotes?: string;
} | null;

export type TriageRequest = {
  userId?: string;
  /** Optional — omit or leave incomplete when GPS is unavailable. */
  gps?: { lat?: number; lng?: number };
  imageBase64?: string;
  audioBase64?: string;
  /** Phone may also send duplicate `image` / `audio` — backend ignores those. */
  iceProfile?: PhoneIceProfilePayload;
  sessionId?: string;
  /** When true, skip live Gemini/Grok and persist a deterministic demo incident. */
  simulate?: boolean;
};

/** Static victim-facing copy keyed by crisis type (not AI-generated). */
export const VICTIM_INSTRUCTIONS: Record<CrisisType, string> = {
  ENVIRONMENTAL_HAZARD:
    "Move away from smoke or hazard if you can do so safely. Stay low. Keep your phone on so responders can find you.",
  MEDICAL_CRISIS:
    "Stay as still as is safe. Keep your airway clear. Help is on the way — do not hang up or lock your phone.",
  ACTIVE_THREAT:
    "Silence your phone. Hide and barricade if possible. Do not confront the threat. Wait for responders.",
  UNKNOWN:
    "Stay put if you are safe. Keep your phone on with the screen facing you. Help is being routed to your last known location.",
};
