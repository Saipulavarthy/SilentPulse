/** Shared contract between triage backend and clients. Additive changes only. */

export type CrisisType =
  | "ENVIRONMENTAL_HAZARD"
  | "MEDICAL_CRISIS"
  | "ACTIVE_THREAT"
  | "LOW_BANDWIDTH_SOS";

export type IncidentStatus = "ACTIVE" | "DISPATCHED" | "RESOLVED";

/** Normalized ICE shape stored in Mongo / attached to incidents. */
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
  gps?: { lat?: number; lng?: number };
  imageBase64?: string;
  audioBase64?: string;
  /** Phone may also send duplicate `image` / `audio` — backend ignores those. */
  iceProfile?: PhoneIceProfilePayload;
  sessionId?: string;
};
