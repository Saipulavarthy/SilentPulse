import type { Incident } from './incident';

/** Unit categories only. Never named units (e.g. "Engine 3"): the pipeline can't know them. */
export const UNIT_TYPES = ['Police', 'EMS', 'Fire', 'Hazmat'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** Unit type and why. No counts: nothing in the pipeline can justify a number. */
export type PlanUnit = {
  type: UnitType;
  reason: string;
};

/** A draft response plan. Every string item is kept under 20 words. */
export type ResponsePlan = {
  units: PlanUnit[];
  /** One or two sentences on staging and entry. */
  approach: string;
  equipment: string[];
  /** From building notes and the medical profile. */
  cautions: string[];
  /** At most 4, in order. */
  firstActions: string[];
  /** What the dispatcher still needs to find out. */
  unknowns: string[];
};

/**
 * `classificationFailed` is set by the triage pipeline on main (Gemini could not classify);
 * declared here as optional so this works before and after that field reaches types/incident.ts.
 */
export type PlanIncident = Incident & { classificationFailed?: boolean };

export type PlanBuilding = {
  name: string;
  type: string;
  floors: number;
  notes?: string;
};

/** POST /api/response-plan body. */
export type PlanRequest = {
  incident: PlanIncident;
  building: PlanBuilding | null;
  /** Other open (not resolved) incidents in the same building. */
  otherOpenInBuilding: number;
};

export type PlanErrorCode = 'bad_request' | 'missing_key' | 'rate_limited' | 'timeout' | 'invalid_output' | 'upstream';

export type PlanResponse =
  | { ok: true; plan: ResponsePlan; model: string; generatedAt: string; /** Items cut to the word limit. */ shortened: number }
  | { ok: false; error: PlanErrorCode; message: string };
