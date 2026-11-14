// Shared response-plan logic: validation of model output, the facts sent to the model,
// and a deterministic rule-based fallback. No SDK imports, so the client can use it too.

import { severityTier, type SeverityTier } from '@/types/incident';
import {
  UNIT_TYPES,
  type PlanBuilding,
  type PlanIncident,
  type PlanUnit,
  type ResponsePlan,
  type UnitType,
} from '@/types/responsePlan';

export const MAX_WORDS = 20;
export const MAX_FIRST_ACTIONS = 4;

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/**
 * Shortens text to fewer than `limit` words. Cuts after the last sentence end (. ! ?) or,
 * failing that, the last clause break (; : , – —) that keeps at least a few words; only
 * if neither exists, cuts at the word limit and adds an ellipsis. Never adds content.
 */
export function shorten(text: string, limit = MAX_WORDS): { text: string; cut: boolean } {
  const w = tokens(text);
  if (w.length < limit) return { text: text.trim(), cut: false };
  const head = w.slice(0, limit - 1);
  const minKeep = Math.min(4, head.length);
  const lastIndex = (re: RegExp) => {
    for (let i = head.length - 1; i >= minKeep - 1; i--) if (re.test(head[i])) return i;
    return -1;
  };
  const sentence = lastIndex(/[.!?]["')\]]?$/);
  if (sentence >= 0) return { text: head.slice(0, sentence + 1).join(' '), cut: true };
  const clause = lastIndex(/[;:,–—]$/);
  if (clause >= 0) return { text: head.slice(0, clause + 1).join(' ').replace(/[;:,–—]$/, ''), cut: true };
  return { text: `${head.join(' ')}…`, cut: true };
}

/**
 * Checks parsed model output against ResponsePlan. Structural problems (wrong types,
 * unknown unit types, empty text, more than 4 first actions) reject
 * the plan. Items of 20+ words (approach: 40+) are kept but shortened at a sentence or
 * clause boundary; `shortened` says how many. Nothing is ever filled in.
 */
export function validatePlan(value: unknown): { plan: ResponsePlan; shortened: number } | { problems: string[] } {
  if (typeof value !== 'object' || value === null) return { problems: ['not an object'] };
  const v = value as Record<string, unknown>;
  const problems: string[] = [];

  if (!Array.isArray(v.units)) problems.push('units is not an array');
  else
    v.units.forEach((u: unknown, i: number) => {
      const unit = (u ?? {}) as Record<string, unknown>;
      if (!UNIT_TYPES.includes(unit.type as UnitType)) problems.push(`units[${i}].type is not one of ${UNIT_TYPES.join('/')}`);
      if (!isText(unit.reason)) problems.push(`units[${i}].reason is missing`);
    });
  if (!isText(v.approach)) problems.push('approach is missing');
  for (const key of ['equipment', 'cautions', 'firstActions', 'unknowns'] as const) {
    if (!isTextList(v[key])) problems.push(`${key} is not a list of non-empty strings`);
  }
  if (Array.isArray(v.firstActions) && v.firstActions.length > MAX_FIRST_ACTIONS) problems.push('firstActions has more than 4 items');
  if (problems.length) return { problems };

  let shortened = 0;
  const fit = (s: string, limit = MAX_WORDS) => {
    const r = shorten(s, limit);
    if (r.cut) shortened++;
    return r.text;
  };
  const plan: ResponsePlan = {
    units: (v.units as PlanUnit[]).map((u) => ({ type: u.type, reason: fit(u.reason) })),
    // "One or two sentences": allow up to 2 × the item limit.
    approach: fit(v.approach as string, MAX_WORDS * 2),
    equipment: (v.equipment as string[]).map((s) => fit(s)),
    cautions: (v.cautions as string[]).map((s) => fit(s)),
    firstActions: (v.firstActions as string[]).map((s) => fit(s)),
    unknowns: (v.unknowns as string[]).map((s) => fit(s)),
  };
  return { plan, shortened };
}

/** Caller's device is silenced during active threats: no calls, texts or audible alerts. */
export const isStealth = (incident: Pick<PlanIncident, 'crisisType'>) => incident.crisisType === 'ACTIVE_THREAT';

const CONTACT = /\b(call(ing)?\s*back|callback|re-?call|(call|phone|ring|text|sms|message|page|alert|notify|contact)(ing)?\s+(the\s+)?(caller|user|reporting party|sender))\b|\baudible\b/i;
const NEGATED = /\b(do\s+not|don'?t|not|never|avoid|without|no)\b/i;

/**
 * Plan items that suggest contacting a caller whose device is in stealth mode (calling back,
 * texting, audible alerts), unless the item is a prohibition ("Do not call back").
 */
export function stealthViolations(plan: ResponsePlan): string[] {
  const items = [plan.approach, ...plan.firstActions, ...plan.equipment, ...plan.units.map((u) => u.reason)];
  return items.filter((s) => CONTACT.test(s) && !NEGATED.test(s));
}

/**
 * The facts the model sees. Deliberately minimal: no names, phone numbers, user id or exact
 * coordinates, which the plan doesn't need and shouldn't leave the system.
 */
export function planFacts(incident: PlanIncident, building: PlanBuilding | null, otherOpenInBuilding: number) {
  const ice = incident.iceProfile;
  // Compact: fields that are absent, false or empty are omitted rather than sent as null.
  return prune({
    crisisType: incident.crisisType,
    callerDevice: isStealth(incident) ? 'stealth mode: no calls, texts or audible/visible alerts' : undefined,
    severityScore: incident.severityScore,
    severityTier: severityTier(incident.severityScore),
    status: incident.status,
    sceneVerified: !incident.lowBandwidth && !incident.classificationFailed,
    lowBandwidth: incident.lowBandwidth || undefined,
    classificationFailed: incident.classificationFailed || undefined,
    dispatcherBrief: incident.dispatcherBrief,
    sceneSummary: incident.sceneSummary,
    gpsAccuracyMetres: incident.gps.accuracy,
    building: building ? prune({ name: building.name, type: building.type, floors: building.floors, notes: building.notes }) : undefined,
    otherOpenIncidentsInSameBuilding: otherOpenInBuilding || undefined,
    // The profile of whoever's phone sent the SOS, not necessarily the person in distress.
    // Ownership is restated here, at the point of use: rule 4 in the prompt alone was not
    // enough for flash-lite models, which then applied it to the person in distress.
    callerMedicalProfile: prune({
      owner: 'caller (owner of the SOS phone); may not be the person in distress',
      age: ice.age,
      conditions: ice.conditions,
      allergies: ice.allergies,
      medications: ice.medications,
    }),
  });
}

/** Drops undefined, null and empty-array fields. */
function prune<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

// ---- rule-based fallback --------------------------------------------------------------------

/** Unit types only: the fallback follows no real protocol, so it never states counts. */
const UNIT_TYPES_FOR: Record<Exclude<SeverityTier, 'low'>, Record<PlanIncident['crisisType'], UnitType[]>> = {
  urgent: { ACTIVE_THREAT: ['Police'], MEDICAL_CRISIS: ['EMS'], ENVIRONMENTAL_HAZARD: ['Fire'], UNKNOWN: ['Police'] },
  critical: {
    ACTIVE_THREAT: ['Police', 'EMS'],
    MEDICAL_CRISIS: ['EMS', 'Fire'],
    ENVIRONMENTAL_HAZARD: ['Fire', 'EMS'],
    UNKNOWN: ['Police', 'EMS'],
  },
  lethal: {
    ACTIVE_THREAT: ['Police', 'EMS'],
    MEDICAL_CRISIS: ['EMS', 'Fire'],
    ENVIRONMENTAL_HAZARD: ['Fire', 'Hazmat', 'EMS'],
    UNKNOWN: ['Police', 'EMS'],
  },
};

const APPROACH: Record<PlanIncident['crisisType'], string> = {
  ACTIVE_THREAT: 'Stage police at a safe distance; EMS waits outside until the scene is secured.',
  MEDICAL_CRISIS: 'Send EMS to the nearest accessible entrance; confirm the patient location on arrival.',
  ENVIRONMENTAL_HAZARD: 'Stage upwind and outside the hazard area; enter only after assessment.',
  UNKNOWN: 'Scene unverified. Approach cautiously and confirm what is happening before committing units.',
};

const EQUIPMENT: Record<PlanIncident['crisisType'], string[]> = {
  ACTIVE_THREAT: ['Ballistic protection', 'Trauma kits'],
  MEDICAL_CRISIS: ['AED', 'Standard medical kit'],
  ENVIRONMENTAL_HAZARD: ['Respiratory protection', 'Gas detection'],
  UNKNOWN: ['Standard medical kit'],
};

const clip = (s: string) => s.trim().split(/\s+/).slice(0, MAX_WORDS - 1).join(' ');

/**
 * Deterministic plan from severity tier and crisis type, plus facts already in the incident.
 * Units carry no counts; each unit's reason is the tier's recommended response text.
 */
export function ruleBasedPlan(
  incident: PlanIncident,
  building: PlanBuilding | null,
  otherOpenInBuilding: number,
  tierResponse: string,
): ResponsePlan {
  const tier = severityTier(incident.severityScore);
  const unverified = incident.lowBandwidth || Boolean(incident.classificationFailed);
  const ice = incident.iceProfile;

  const cautions = [
    ...(unverified ? ['Scene unverified: no image or audio classification'] : []),
    ...(isStealth(incident) ? ['Caller device in stealth mode; do not call back'] : []),
    // The ICE profile is the caller's, who may not be the person in distress.
    ...ice.allergies.map((a) => `Caller allergy: ${a}`),
    ...ice.conditions.map((c) => `Caller condition: ${c}`),
    ...ice.medications.map((m) => `Caller medication: ${m}`),
    ...(building?.notes ? [clip(`Building: ${building.notes}`)] : []),
  ];

  const unknowns = [
    ...(building ? ['Exact location inside the building'] : ['Exact location']),
    'Number of people involved',
    "Caller's current condition",
    ...(otherOpenInBuilding > 0 ? [`How ${otherOpenInBuilding} other open call(s) here relate to this one`] : []),
  ];

  if (tier === 'low') {
    return {
      units: [],
      approach: 'Flag for review; no dispatch unless review confirms an emergency.',
      equipment: [],
      cautions,
      firstActions: [
        'Review incident details and location',
        ...(isStealth(incident) ? [] : ['Attempt contact through the app']),
        'Dispatch only if new information confirms an emergency',
      ],
      unknowns,
    };
  }

  const types = UNIT_TYPES_FOR[tier][incident.crisisType];
  const where = building ? clip(`Confirm access to ${building.name}`) : 'Confirm the caller location from GPS';
  return {
    units: types.map((type) => ({ type, reason: tierResponse })),
    approach: APPROACH[incident.crisisType],
    equipment: EQUIPMENT[incident.crisisType],
    cautions,
    firstActions: [
      `Dispatch ${types.join(' and ')}`,
      where,
      unverified ? 'Treat the scene as unverified until units report' : 'Relay the dispatcher brief to responding units',
      'Update units with any new caller information',
    ],
    unknowns,
  };
}
