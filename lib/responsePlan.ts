// Shared response-plan logic: the facts sent to the model, which sources each incident has,
// the deterministic situation line, validation of model output, and the rule-based fallback.
// No SDK imports, so the client can use it too.

import { severityTier } from '@/types/incident';
import {
  PLAN_SOURCES,
  type OtherCaller,
  type PlanBuilding,
  type PlanIncident,
  type PlanItem,
  type PlanSource,
  type ResponsePlan,
} from '@/types/responsePlan';

export const MAX_WORDS = 20;
export const MAX_RISKS = 3;
export const MAX_ACTIONS = 3;
export const MAX_UNKNOWNS = 4;
const MAX_BRIEF_SENTENCES = 2;

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

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

/** Abbreviations whose period does not end a sentence: initials (W.E.B.) and common short forms. */
const NOT_A_SENTENCE_END = /^(([A-Za-z]\.)+|Dr\.|St\.|Mr\.|Mrs\.|Ms\.|No\.|vs\.|approx\.|e\.g\.|i\.e\.)$/;

/** Splits into sentences on . ! ? followed by a space, ignoring initials and abbreviations. */
function sentences(s: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const word of s.trim().split(/\s+/).filter(Boolean)) {
    current.push(word);
    if (/[.!?]["')\]]?$/.test(word) && !NOT_A_SENTENCE_END.test(word)) {
      out.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) out.push(current.join(' '));
  return out;
}

// ---- safety and specificity filters --------------------------------------------------------------

/** Caller's device is silenced during active threats: no calls, texts or audible alerts. */
export const isStealth = (incident: Pick<PlanIncident, 'crisisType'>) => incident.crisisType === 'ACTIVE_THREAT';

const CONTACT = /\b(call(ing)?\s*back|callback|re-?call|(call|phone|ring|text|sms|message|page|alert|notify|contact)(ing)?\s+(the\s+)?(caller|user|reporting party|sender))\b|\baudible\b/i;
const NEGATED = /\b(do\s+not|don'?t|not|never|avoid|without|no)\b/i;
/** Suggests contacting a caller in stealth mode, and is not a prohibition ("Do not call back"). */
const contactsCaller = (s: string) => CONTACT.test(s) && !NEGATED.test(s);

/** Advice that fits any incident of the type, which the dispatcher already knows. */
const GENERIC =
  /\b(protective (gear|equipment)|body armou?r|ballistic|ppe|radios?\b|radio contact|perimeter|stage (units|nearby|at a safe)|staging area|use caution|proceed with caution|approach (with )?caution|exercise caution|stay safe|dispatch (units|appropriate)|standard (police|medical) (gear|kit|equipment))/i;

/** "Scene is verified" and similar: the pipeline can never verify a scene. */
const CLAIMS_VERIFIED = /\b(?<!un)verified\b|\bconfirmed (scene|threat|emergency)\b/i;
/** Any talk of verification: only allowed when the input marks the scene unverified. */
const MENTIONS_VERIFICATION = /\b(un)?verified\b|\bunconfirmed\b/i;

// ---- facts and sources ---------------------------------------------------------------------------

const minutesSince = (iso: string | undefined, now: number) =>
  iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)) : undefined;

/** Drops undefined, null, false and empty-array fields. */
function prune<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

/** The caller-profile fields that can change what responders do. */
function callerProfile(incident: PlanIncident) {
  const ice = incident.iceProfile;
  if (!ice) return undefined;
  const profile = prune({
    age: ice.age,
    conditions: ice.conditions,
    allergies: ice.allergies,
    medications: ice.medications,
    mobilityNotes: ice.mobilityNotes,
    sensoryNotes: ice.sensoryNotes,
  });
  const { age, ...rest } = profile;
  if (Object.keys(rest).length === 0) return undefined;
  // Ownership restated at the point of use: flash-lite models otherwise apply it to the patient.
  return { owner: 'caller (owner of the SOS phone); may not be the person in distress', age, ...rest };
}

function timelineFacts(incident: PlanIncident, now: number) {
  const tl = incident.timeline ?? [];
  const updates = Math.max(tl.length, incident.updateCount ?? 0, 1);
  if (updates <= 1 && !incident.escalated) return undefined;
  return prune({
    updates,
    minutesSinceFirstAlert: minutesSince(tl[0]?.ts ?? incident.createdAt, now),
    severityHistory: tl.length > 1 ? tl.map((t) => t.severityScore) : undefined,
    trend: incident.trend,
    signalLost: incident.escalated ? (incident.escalationReason ?? 'signal lost') : undefined,
    minutesSinceLastUpdate: incident.escalated ? minutesSince(incident.lastSeenAt, now) : undefined,
  });
}

/**
 * The facts the model sees, grouped by the source names plan items must cite. Deliberately
 * minimal: no names, phone numbers, user id or exact coordinates.
 */
export function planFacts(incident: PlanIncident, building: PlanBuilding | null, otherCallers: OtherCaller[], now = Date.now()) {
  // Only present when it applies: mentioning verification otherwise primes the model to hedge.
  const sceneStatus = incident.lowBandwidth
    ? 'unverified: no image or audio was received'
    : incident.classificationFailed
      ? 'unverified: image/audio could not be classified'
      : undefined;
  return prune({
    crisisType: incident.crisisType,
    severityScore: incident.severityScore,
    severityTier: severityTier(incident.severityScore),
    status: incident.status,
    sceneStatus,
    callerDevice: isStealth(incident) ? 'stealth mode: no calls, texts or audible/visible alerts' : undefined,
    building: building ? prune({ name: building.name, type: building.type, floors: building.floors }) : undefined,
    callersInBuilding: building ? 1 + otherCallers.length : undefined,
    gpsAccuracyMetres: incident.gps?.accuracy,
    // ---- sources ----
    buildingNotes: building?.notes,
    callerProfile: callerProfile(incident),
    perception: prune({ sceneSummary: incident.sceneSummary, cues: incident.cues }),
    triage: prune({ dispatcherBrief: incident.dispatcherBrief, reasons: incident.reasons }),
    timeline: timelineFacts(incident, now),
    otherCallers: otherCallers.length
      ? otherCallers.map((o) => ({
          crisisType: o.crisisType,
          severityScore: o.severityScore,
          minutesAgo: minutesSince(o.createdAt, now),
          summary: o.summary,
        }))
      : undefined,
  });
}

/** Sources that actually exist in these facts; items citing anything else are dropped. */
export function availableSources(facts: ReturnType<typeof planFacts>): Set<PlanSource> {
  const present = (v: unknown) => v !== undefined && !(typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  return new Set(PLAN_SOURCES.filter((s) => present(facts[s])));
}

/**
 * One line on everything open in the building plus this incident's timeline: callers, minutes
 * since first alert, trend, signal loss. Undefined with one caller and one update.
 */
export function situationLine(incident: PlanIncident, building: PlanBuilding | null, otherCallers: OtherCaller[], now = Date.now()) {
  const tl = incident.timeline ?? [];
  const updates = Math.max(tl.length, incident.updateCount ?? 0, 1);
  const callers = 1 + otherCallers.length;
  if (callers === 1 && updates <= 1 && !incident.escalated) return undefined;

  const firstAlert = [tl[0]?.ts ?? incident.createdAt, ...otherCallers.map((o) => o.createdAt)].sort()[0];
  const parts = [
    callers > 1 ? `${callers} callers${building ? ` in ${building.name}` : ''}` : undefined,
    `first alert ${minutesSince(firstAlert, now)} min ago`,
    updates > 1 ? `${updates} updates${tl.length > 1 ? ` (severity ${tl.map((t) => t.severityScore).join('→')})` : ''}` : undefined,
    incident.trend && incident.trend !== 'new' ? incident.trend : undefined,
    incident.escalated
      ? `signal lost${incident.lastSeenAt ? ` ${minutesSince(incident.lastSeenAt, now)} min ago` : ''}`
      : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

// ---- validation ----------------------------------------------------------------------------------

export type ValidatedPlan = { plan: ResponsePlan; shortened: number; dropped: string[] };

/**
 * Checks parsed model output. Structural problems (missing radio brief, lists that are not
 * lists) reject the plan. Individual items are dropped, not the plan, when their source is
 * not in the input, they are generic, they claim the scene is verified, they would expose a
 * caller in stealth mode, or they exceed the per-list limit. Long items are shortened.
 */
export function validatePlan(
  value: unknown,
  sources: Set<PlanSource>,
  opts: { stealth: boolean; unverified: boolean },
): ValidatedPlan | { problems: string[] } {
  if (typeof value !== 'object' || value === null) return { problems: ['not an object'] };
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isText(v.radioBrief)) problems.push('radioBrief is missing');
  for (const key of ['risks', 'actions', 'unknowns'] as const) if (!Array.isArray(v[key])) problems.push(`${key} is not a list`);
  if (problems.length) return { problems };

  let shortened = 0;
  const dropped: string[] = [];
  const fit = (s: string, limit = MAX_WORDS) => {
    const r = shorten(s, limit);
    if (r.cut) shortened++;
    return r.text;
  };

  const items = (key: 'risks' | 'actions', max: number): PlanItem[] => {
    const kept: PlanItem[] = [];
    for (const raw of v[key] as unknown[]) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const text = isText(item.text) ? item.text.trim() : '';
      const source = item.source as PlanSource;
      const why = !text
        ? 'empty'
        : !PLAN_SOURCES.includes(source)
          ? `unknown source "${String(item.source)}"`
          : !sources.has(source)
            ? `source "${source}" not in input`
            : GENERIC.test(text)
              ? 'generic'
              : CLAIMS_VERIFIED.test(text) || (!opts.unverified && MENTIONS_VERIFICATION.test(text))
                ? 'verification claim'
                : opts.stealth && contactsCaller(text)
                  ? 'contacts stealth caller'
                  : kept.length >= max
                    ? `over ${max}`
                    : null;
      if (why) dropped.push(`${key}: ${why}: ${text.slice(0, 80)}`);
      else kept.push({ text: fit(text), source });
    }
    return kept;
  };

  // Radio brief: at most 2 sentences, without "verified" claims or stealth violations.
  const briefSentences = sentences((v.radioBrief as string).trim()).filter((s) => {
    const bad = CLAIMS_VERIFIED.test(s)
      ? 'claims verified'
      : !opts.unverified && MENTIONS_VERIFICATION.test(s)
        ? 'mentions verification for a scene not marked unverified'
        : opts.stealth && contactsCaller(s)
          ? 'contacts stealth caller'
          : null;
    if (bad) dropped.push(`radioBrief: ${bad}: ${s.slice(0, 80)}`);
    return !bad;
  });
  if (briefSentences.length === 0) return { problems: ['radioBrief had nothing usable'] };
  if (briefSentences.length > MAX_BRIEF_SENTENCES) dropped.push(`radioBrief: over ${MAX_BRIEF_SENTENCES} sentences`);
  const radioBrief = fit(briefSentences.slice(0, MAX_BRIEF_SENTENCES).join(' '), MAX_WORDS * 2);

  const unknowns = (v.unknowns as unknown[]).filter(isText).map((s) => s.trim());
  if (unknowns.length > MAX_UNKNOWNS) dropped.push(`unknowns: over ${MAX_UNKNOWNS}`);

  return {
    plan: {
      radioBrief,
      risks: items('risks', MAX_RISKS),
      actions: items('actions', MAX_ACTIONS),
      unknowns: unknowns.slice(0, MAX_UNKNOWNS).map((s) => fit(s)),
    },
    shortened,
    dropped,
  };
}

// ---- rule-based fallback -------------------------------------------------------------------------

const TYPE_WORDS: Record<PlanIncident['crisisType'], string> = {
  ACTIVE_THREAT: 'Active threat',
  MEDICAL_CRISIS: 'Medical emergency',
  ENVIRONMENTAL_HAZARD: 'Environmental hazard',
  UNKNOWN: 'Unclassified SOS',
};

/**
 * Templated plan from facts already in the incident (no AI): a radio brief and the situation
 * line. The panel shows it with the tier's recommended response, labelled rule-based.
 */
export function ruleBasedPlan(incident: PlanIncident, building: PlanBuilding | null, otherCallers: OtherCaller[]): ResponsePlan {
  const callers = 1 + otherCallers.length;
  const unverified = incident.lowBandwidth || incident.classificationFailed;
  const first = `${TYPE_WORDS[incident.crisisType]} at ${building?.name ?? 'an unknown location'}, severity ${incident.severityScore}${
    callers > 1 ? `, ${callers} callers` : ''
  }.`;
  const second = isStealth(incident)
    ? 'Caller is hiding with the phone in stealth mode; do not call back.'
    : unverified
      ? 'Scene unverified: no image or audio received.'
      : incident.escalated
        ? 'Signal lost from the caller.'
        : '';
  return {
    radioBrief: [first, second].filter(Boolean).join(' '),
    situation: situationLine(incident, building, otherCallers),
    risks: [],
    actions: [],
    unknowns: [],
  };
}
