// POST /api/incidents/:id/notify-contact/draft: a call script for the dispatcher to review.
// Gemini drafts it from a few safe facts (names, time, building only if certain, responder
// status); nothing medical, no coordinates and no crisis details are sent to the model. A draft
// that fails validation, or any Gemini failure, falls back to a deterministic template.
//
// Only POST is exported: never cached or prerendered (Cache Components).

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIFetchError,
  SchemaType,
  type GenerationConfig,
  type ResponseSchema,
} from '@google/generative-ai';
import mongoose from 'mongoose';
import {
  CLOSING,
  DEMO_PREAMBLE,
  IDENTITY,
  LISTED_YOU,
  OTHER_INSTRUCTION,
  SCRIPT_WORD_LIMIT,
  THREAT_INSTRUCTION,
  ineligibleReason,
  scriptCheckFor,
  scriptFacts,
  templateScript,
  validateScript,
  type ScriptFacts,
} from '@/lib/contactCall';
import { connectToDatabase } from '@/lib/mongodb';
import { serializeIncident } from '@/lib/serializeIncident';
import { ActiveIncident } from '@/models/Incident';
import type { ContactCallErrorCode, ContactDraftResponse } from '@/types/contactCall';
import { demoMode } from '../twilio';

const TIMEOUT_MS = 20_000;
export const maxDuration = 25;
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_THINKING_LEVEL = 'minimal';

const SYSTEM_PROMPT = `You write the script for an automated voice call to someone's emergency contact. A text-to-speech voice reads it on the phone.
Write at most ${SCRIPT_WORD_LIMIT} words of plain spoken English: short sentences, no abbreviations, no symbols, no lists.
Structure, in this order:
1. Greet the contact by name if contactName is given, then say who is calling and why: "This is ${IDENTITY}." and that callerName ${LISTED_YOU}.
2. alert: say they triggered an emergency alert at alertTime (and from building, only if building is given) and that responders have been notified, or dispatched if respondersStatus is "dispatched". Say nothing else about what happened.
3. alert: copy requiredInstruction word for word.
4. alert: end with closingSentence word for word.
For an allClear call instead: say who is calling ("This is ${IDENTITY}, calling again about callerName"), that the situation has been resolved, that they may now contact them, and that this is the last message from SilentPulse about this alert.
Rules:
- Never claim to be or mention the police, 911, a university or any official body or service.
- Never describe the emergency, injuries, health, medicine, weapons or danger. Use only the facts given.
- contactRelation is the contact's relationship to the caller as the caller entered it (for example "Mother" means the contact is the caller's mother). Use it only if it reads naturally; never guess anyone's gender.
- If callerName is missing, say "someone" instead of a name.`;

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: { script: { type: SchemaType.STRING } },
  required: ['script'],
};

const STATUS: Partial<Record<ContactCallErrorCode, number>> = { bad_request: 400, not_found: 404, not_eligible: 409, upstream: 502 };
const json = (body: ContactDraftResponse) =>
  Response.json(body, { status: body.ok ? 200 : (STATUS[body.error] ?? 500), headers: { 'Cache-Control': 'no-store' } });

/** What the model sees: no crisis type, no medical data, no coordinates. */
function modelInput(f: ScriptFacts) {
  return {
    callKind: f.kind,
    callerName: f.callerName,
    contactName: f.contactName,
    contactRelation: f.contactRelation,
    ...(f.kind === 'alert'
      ? {
          alertTime: f.alertTime,
          building: f.building,
          respondersStatus: f.respondersDispatched ? 'dispatched' : 'notified',
          requiredInstruction: f.threat ? THREAT_INSTRUCTION : OTHER_INSTRUCTION,
          closingSentence: CLOSING,
        }
      : {}),
  };
}

async function geminiDraft(f: ScriptFacts): Promise<{ script: string; model: string } | { reason: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { reason: 'GEMINI_API_KEY is not set.' };
  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  // thinkingConfig is passed through untyped by the 0.24.1 SDK (same as /api/response-plan).
  const generationConfig: GenerationConfig & { thinkingConfig: { thinkingLevel: string } } = {
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    temperature: 0.2,
    thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || DEFAULT_THINKING_LEVEL },
  };
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel(
    { model: modelName, systemInstruction: SYSTEM_PROMPT, generationConfig },
    { timeout: TIMEOUT_MS },
  );
  try {
    const result = await model.generateContent(JSON.stringify(modelInput(f)), { timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const parsed = JSON.parse(result.response.text()) as { script?: unknown };
    if (typeof parsed.script !== 'string' || !parsed.script.trim()) return { reason: 'Gemini returned no script.' };
    return { script: parsed.script.replace(/\s+/g, ' ').trim(), model: modelName };
  } catch (err) {
    const name = (err as Error)?.name;
    if (err instanceof GoogleGenerativeAIAbortError || name === 'TimeoutError' || name === 'AbortError') return { reason: 'Gemini timed out.' };
    if (err instanceof GoogleGenerativeAIFetchError) return { reason: `Gemini request failed (${err.status ?? 'network'}).` };
    if (err instanceof SyntaxError) return { reason: 'Gemini returned invalid JSON.' };
    return { reason: 'Gemini request failed.' };
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) return json({ ok: false, error: 'bad_request', message: 'Invalid incident id' });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const kind = body?.kind;
    if (kind !== 'alert' && kind !== 'allClear') return json({ ok: false, error: 'bad_request', message: 'kind must be "alert" or "allClear".' });
    const building = typeof body?.building === 'string' ? body.building : null;

    await connectToDatabase();
    const doc = await ActiveIncident.findById(id).lean();
    if (!doc) return json({ ok: false, error: 'not_found', message: 'Incident not found' });
    const incident = serializeIncident(doc);
    const ineligible = ineligibleReason(incident, kind);
    if (ineligible) return json({ ok: false, error: 'not_eligible', message: ineligible });

    const facts = scriptFacts(incident, kind, building);
    const check = scriptCheckFor(incident, kind, facts, true);
    const preamble = demoMode() ? DEMO_PREAMBLE : null;

    const ai = await geminiDraft(facts);
    if ('script' in ai) {
      const problems = validateScript(ai.script, check);
      if (problems.length === 0) return json({ ok: true, preamble, script: ai.script, source: 'ai', model: ai.model });
      console.warn('[notify-contact] Gemini draft rejected:', problems);
      return json({ ok: true, preamble, script: templateScript(facts), source: 'template', templateReason: `Gemini draft failed checks: ${problems[0]}` });
    }
    return json({ ok: true, preamble, script: templateScript(facts), source: 'template', templateReason: ai.reason });
  } catch (error) {
    console.error('[notify-contact] draft unexpected error:', (error as Error)?.message);
    return json({ ok: false, error: 'upstream', message: 'Internal server error' });
  }
}
