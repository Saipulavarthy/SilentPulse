// Emergency-contact calls: rules shared by the API route and the dashboard. Pure: no env, no I/O,
// so the dashboard can use the same validation for its word counter and mock mode.

import { LANDMARKS } from '@/lib/landmarks';
import { profileTerms } from '@/lib/responsePlan';
import type { ContactCall, ContactCallKind } from '@/types/contactCall';
import { CONTACT_CALL_ACTIVE } from '@/types/contactCall';
import type { CrisisType, Incident } from '@/types/incident';

export const CONTACT_MIN_SEVERITY = 7;
export const SCRIPT_WORD_LIMIT = 70;
/** Twilio's limit for the inline `Twiml` parameter. */
export const TWIML_MAX_CHARS = 4000;
/**
 * Amazon Polly neural voice: natural and generally available on a standard account. (Polly
 * generative and Google Chirp3-HD voices sound closer still, but Twilio offers them as a
 * public beta.)
 */
export const CALL_VOICE = 'Polly.Joanna-Neural';
/** Times are spoken in campus time, wherever the server runs. */
export const CAMPUS_TIME_ZONE = 'America/New_York';

export const DEMO_PREAMBLE = 'This is a test of the SilentPulse demo. This is not a real emergency.';
export const IDENTITY = 'SilentPulse, an emergency alert app';
export const LISTED_YOU = 'listed you as their emergency contact';
export const THREAT_INSTRUCTION = 'Please do not call or text them. Their phone must stay silent for their safety.';
export const OTHER_INSTRUCTION = 'Please keep your phone nearby. You do not need to do anything now.';
export const CLOSING = 'We will call you again when the situation is resolved.';

// ---- phone numbers ------------------------------------------------------------------------------

/** E.164 (+ and 8–15 digits). 10-digit numbers are taken as US (+1). Null if it can't be one. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Comma-separated list (e.g. NOTIFY_ALLOWLIST) → normalized set; unparseable entries dropped. */
export function parseAllowlist(raw: string | null | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => normalizePhone(s)).filter((s): s is string => s !== null));
}

export const lastFour = (phone: string) => phone.replace(/\D/g, '').slice(-4);

// ---- eligibility --------------------------------------------------------------------------------

type CallIncident = Pick<Incident, 'severityScore' | 'status' | 'iceProfile'> & { contactCalls?: ContactCall[] };

export const contactPhone = (i: Pick<Incident, 'iceProfile'>) => i.iceProfile?.emergencyContact?.phone?.trim() || null;

/** Newest call of a kind (or of any kind). */
export function latestCall(calls: ContactCall[] | undefined, kind?: ContactCallKind): ContactCall | null {
  const list = (calls ?? []).filter((c) => !kind || c.kind === kind);
  return list.reduce<ContactCall | null>((a, c) => (!a || Date.parse(c.requestedAt) >= Date.parse(a.requestedAt) ? c : a), null);
}

/** An alert call went out (whatever the outcome other than failing to connect at all). */
export const alertWasPlaced = (calls: ContactCall[] | undefined) =>
  (calls ?? []).some((c) => c.kind === 'alert' && c.callSid !== '' && c.status !== 'failed' && c.status !== 'canceled');

/** Why this kind of call can't be placed for the incident, or null when it can. */
export function ineligibleReason(i: CallIncident, kind: ContactCallKind): string | null {
  if (!contactPhone(i)) return 'No emergency contact phone on file.';
  if (kind === 'alert') {
    if (i.status === 'RESOLVED') return 'Incident is resolved.';
    if (i.severityScore < CONTACT_MIN_SEVERITY) return `Severity ${i.severityScore} is below ${CONTACT_MIN_SEVERITY}.`;
    return null;
  }
  if (i.status !== 'RESOLVED') return 'An all-clear call needs the incident to be resolved first.';
  if (!alertWasPlaced(i.contactCalls)) return 'No alert call was placed, so there is nothing to clear.';
  return null;
}

/** A second call of the same kind needs force; never while one is still in progress. */
export function duplicateReason(calls: ContactCall[] | undefined, kind: ContactCallKind, force: boolean): string | null {
  const prev = latestCall(calls, kind);
  if (!prev) return null;
  if (CONTACT_CALL_ACTIVE.includes(prev.status)) return 'A call to this contact is still in progress.';
  if (!force) return kind === 'alert' ? 'The contact has already been called about this incident.' : 'The all-clear call was already placed.';
  return null;
}

// ---- script facts and template ------------------------------------------------------------------

/** Everything a script may be drawn from. Deliberately no crisis details, medical data or coordinates. */
export type ScriptFacts = {
  kind: ContactCallKind;
  /** Chooses the instruction; never spoken. */
  threat: boolean;
  callerName: string | null;
  contactName: string | null;
  /** The contact's relationship to the caller, as entered by the caller (e.g. "Mother"). */
  contactRelation: string | null;
  /** e.g. "9:58 in the evening". */
  alertTime: string;
  /** Always null for an active-threat alert: the contact must not be told where the person is. */
  building: string | null;
  respondersDispatched: boolean;
};

/** "KAI MORGAN" / "kai morgan" → "Kai Morgan"; mixed case is left alone. */
function properName(s: string | null | undefined): string | null {
  const v = s?.trim().replace(/\s+/g, ' ');
  if (!v) return null;
  if (v !== v.toUpperCase() && v !== v.toLowerCase()) return v;
  return v.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Spoken clock time without abbreviations: "9:58 in the evening". */
export function spokenTime(iso: string, timeZone = CAMPUS_TIME_ZONE): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'earlier today';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 5 ? 'in the early morning' : h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening';
  return `${h12}:${m} ${part}`;
}

export function scriptFacts(
  incident: Pick<Incident, 'crisisType' | 'status' | 'iceProfile' | 'createdAt'>,
  kind: ContactCallKind,
  building: string | null | undefined,
): ScriptFacts {
  const contact = incident.iceProfile?.emergencyContact;
  const threatAlert = incident.crisisType === 'ACTIVE_THREAT' && kind === 'alert';
  return {
    kind,
    threat: incident.crisisType === 'ACTIVE_THREAT',
    callerName: properName(incident.iceProfile?.name),
    contactName: properName(contact?.name),
    contactRelation: contact?.relation?.trim() || null,
    alertTime: spokenTime(incident.createdAt),
    building: threatAlert ? null : building?.trim() || null,
    respondersDispatched: incident.status === 'ACKNOWLEDGED',
  };
}

/** Deterministic script with the required structure; used when Gemini is unavailable or fails validation. */
export function templateScript(f: ScriptFacts): string {
  const hello = f.contactName ? `Hello ${f.contactName}.` : 'Hello.';
  const who = f.callerName ?? 'Someone';
  if (f.kind === 'allClear') {
    return [
      hello,
      `This is ${IDENTITY}, calling again about ${f.callerName ?? 'the person who listed you as their emergency contact'}.`,
      'The situation has been resolved, and you may now contact them.',
      'This is the last message from SilentPulse about this alert.',
    ].join(' ');
  }
  return [
    hello,
    `This is ${IDENTITY}. ${who} ${LISTED_YOU}.`,
    `They triggered an emergency alert at ${f.alertTime}${f.building ? ` from ${f.building}` : ''}, and responders have been ${f.respondersDispatched ? 'dispatched' : 'notified'}.`,
    f.threat ? THREAT_INSTRUCTION : OTHER_INSTRUCTION,
    CLOSING,
  ].join(' ');
}

/** The full text spoken on the call. */
export const spokenText = (preamble: string | null, script: string) => (preamble ? `${preamble} ${script}` : script).trim();

// ---- validation ---------------------------------------------------------------------------------

export const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Lower case, straight quotes, letters/digits/spaces only: for "does it contain this sentence". */
const flat = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const contains = (text: string, phrase: string) => ` ${flat(text)} `.includes(` ${flat(phrase)} `);

const OFFICIAL =
  /\b(police|911|nine[\s-]one[\s-]one|universit(y|ies)|umass|college|sheriff|fire department|fire ?fighters?|law enforcement|authorit(y|ies)|government|official(s|ly)?|officers?|emergency services|ambulances?|paramedics?|security)\b/i;
const COORDINATES = /-?\b\d{1,3}\.\d{3,}\b|\b(lat|lng|latitude|longitude|coordinates?|gps)\b/i;
const MEDICAL =
  /\b(allerg\w*|medications?|medicines?|prescri\w*|diagnos\w*|blood type|seizures?|diabet\w*|asthma\w*|epilep\w*|insulin|inhalers?|cardiac|heart attack|overdose\w*|injur\w*|bleed\w*|unconscious)\b/i;
const THREAT_DETAIL =
  /\b(threats?|shoot\w*|shots?|guns?|gunfire|gunm[ae]n|weapons?|armed|attack\w*|assault\w*|violen\w*|hostages?|intruders?|lockdown|knife|knives|stab\w*|suspects?|robber\w*)\b/i;
/** Abbreviations: all-caps tokens, dotted forms (a.m., e.g.) and common shortenings. */
const ABBREVIATIONS = [/\b[A-Z]{2,}\b/, /\b(?:[A-Za-z]\.){2,}/, /\b(?:mins?|hrs?|secs?|approx|asap|etc|dept|govt|bldg|appt)\b\.?/i, /\b(?:St|Dr|Mr|Mrs|Ms|Jr|Sr|No)\.(?=\s)/];

export type ScriptCheck = {
  kind: ContactCallKind;
  crisisType: CrisisType;
  /** Medical terms from the caller's profile (conditions, allergies, medications). */
  profileTerms: string[];
  /** Proper names allowed to contain capitals or dots (people, building). */
  names: string[];
  /** Active-threat alert only: building names that must not appear (campus landmarks + the incident's). */
  forbiddenPlaces: string[];
  /** Model drafts must also keep every structural sentence; dispatcher edits only the safety ones. */
  strict: boolean;
};

/** Every campus building name, for the active-threat location rule. */
const PLACE_NAMES = [...new Set(LANDMARKS.map((l) => l.name.trim()).filter(Boolean))];

export function scriptCheckFor(incident: Incident, kind: ContactCallKind, facts: ScriptFacts, strict: boolean): ScriptCheck {
  const people = [facts.callerName, facts.contactName, incident.iceProfile?.name, incident.iceProfile?.emergencyContact?.name]
    .filter((s): s is string => Boolean(s))
    .map(flat);
  const threatAlert = incident.crisisType === 'ACTIVE_THREAT' && kind === 'alert';
  // A landmark that is also part of someone's name (a contact called "Linden") is not a location here.
  const forbiddenPlaces = threatAlert
    ? [...PLACE_NAMES, incident.building?.name].filter(
        (p): p is string => Boolean(p) && !people.some((n) => ` ${n} `.includes(` ${flat(p!)} `)),
      )
    : [];
  return {
    forbiddenPlaces,
    kind,
    crisisType: incident.crisisType,
    profileTerms: profileTerms(incident),
    names: [facts.callerName, facts.contactName, facts.building, incident.iceProfile?.name, incident.iceProfile?.emergencyContact?.name].filter(
      (s): s is string => Boolean(s),
    ),
    strict,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Problems with a script; empty when it may be spoken. */
export function validateScript(text: string, c: ScriptCheck): string[] {
  const problems: string[] = [];
  const t = text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!t) return ['The script is empty.'];
  const words = countWords(t);
  if (words > SCRIPT_WORD_LIMIT) problems.push(`${words} words; the limit is ${SCRIPT_WORD_LIMIT}.`);
  if (!contains(t, IDENTITY)) problems.push(`It must identify itself as "${IDENTITY}".`);
  const threat = c.crisisType === 'ACTIVE_THREAT';
  if (threat && c.kind === 'alert' && !contains(t, THREAT_INSTRUCTION)) {
    problems.push(`An active-threat call must include: "${THREAT_INSTRUCTION}"`);
  }
  if (c.strict) {
    if (c.kind === 'alert') {
      if (!contains(t, LISTED_YOU)) problems.push(`It must say the caller "${LISTED_YOU}".`);
      if (!threat && !contains(t, OTHER_INSTRUCTION)) problems.push(`It must include: "${OTHER_INSTRUCTION}"`);
      if (!contains(t, CLOSING)) problems.push(`It must end with: "${CLOSING}"`);
    } else {
      if (!/\bresolved\b/i.test(t)) problems.push('An all-clear call must say the situation has been resolved.');
      if (!/\bcontact them\b/i.test(t)) problems.push('An all-clear call must say they may now contact the person.');
      if (!/\blast message\b/i.test(t)) problems.push('An all-clear call must say this is the last message.');
    }
  }
  // Names (people, building) may contain capitals or dots; check everything else for abbreviations.
  let rest = t.replace(/SilentPulse/g, 'app');
  for (const n of c.names) rest = rest.replace(new RegExp(escapeRe(n), 'gi'), 'name');
  if (OFFICIAL.test(rest)) problems.push(`It must not name or claim to be an official body ("${rest.match(OFFICIAL)![0]}").`);
  if (COORDINATES.test(t)) problems.push('It must not include coordinates or GPS details.');
  const medical = rest.match(MEDICAL)?.[0] ?? c.profileTerms.find((term) => new RegExp(`\\b${escapeRe(term)}\\b`, 'i').test(rest));
  if (medical) problems.push(`It must not include medical details ("${medical}").`);
  const place = c.forbiddenPlaces.find((p) => contains(t, p));
  if (place) problems.push(`An active-threat call must not say where the person is ("${place}").`);
  if (threat && THREAT_DETAIL.test(rest)) problems.push(`It must not say what the threat is ("${rest.match(THREAT_DETAIL)![0]}").`);
  const abbr = ABBREVIATIONS.map((re) => rest.match(re)?.[0]).find(Boolean);
  if (abbr) problems.push(`No abbreviations ("${abbr}").`);
  return problems;
}

// ---- TwiML --------------------------------------------------------------------------------------

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The message twice, with a pause between. No webhooks or callbacks. */
export function buildTwiml(text: string): string {
  const say = `<Say voice="${CALL_VOICE}" language="en-US">${escapeXml(text)}</Say>`;
  return `<Response><Pause length="1"/>${say}<Pause length="2"/>${say}</Response>`;
}
