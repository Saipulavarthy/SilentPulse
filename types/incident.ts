// Shared contract between the triage backend and the dispatcher dashboard.
// Changes here need sign-off from both sides.

/** UNKNOWN = low-bandwidth SOS where no image/audio was sent, so nothing was classified. */
export type CrisisType =
  | 'ENVIRONMENTAL_HAZARD'
  | 'MEDICAL_CRISIS'
  | 'ACTIVE_THREAT'
  | 'UNKNOWN';

export type IncidentStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface IceProfile {
  name: string;
  age?: number;
  conditions: string[];
  allergies: string[];
  medications: string[];
  emergencyContact: {
    name: string;
    phone: string;
  };
}

export interface Building {
  name: string;
  type: string;
  floors: number;
  notes?: string;
  /** Ground elevation at the building, metres. Must use the same vertical datum as gps.altitude. */
  groundElevationM?: number;
}

export interface Incident {
  _id: string;
  userId: string;
  crisisType: CrisisType;
  /** Integer 1-10, assigned by Grok. */
  severityScore: number;
  dispatcherBrief: string;
  /** One line on what Gemini saw/heard. Absent for low-bandwidth SOS. */
  sceneSummary?: string;
  gps: {
    lat: number;
    lng: number;
    /** Horizontal accuracy radius, metres (Geolocation API coords.accuracy). */
    accuracy?: number;
    /** Altitude, metres, as reported by the device (Geolocation API coords.altitude). */
    altitude?: number;
  };
  building?: Building;
  /** Snapshot of the user's ICE profile at the time of the SOS. */
  iceProfile: IceProfile;
  lowBandwidth: boolean;
  status: IncidentStatus;
  /** ISO 8601 string. */
  createdAt: string;
  /** ISO 8601 string. */
  updatedAt: string;
}

export type SeverityTier = 'low' | 'urgent' | 'critical' | 'lethal';

/** 1-3 low, 4-6 urgent, 7-8 critical, 9-10 lethal. Out-of-range scores are clamped. */
export function severityTier(score: number): SeverityTier {
  if (score >= 9) return 'lethal';
  if (score >= 7) return 'critical';
  if (score >= 4) return 'urgent';
  return 'low';
}
