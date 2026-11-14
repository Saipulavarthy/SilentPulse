// POST /api/response-plan: drafts a response plan for one incident with Gemini.
//
// Only POST is exported. Non-GET route handlers are never cached or prerendered, and with
// Cache Components on, `dynamic` / `runtime` segment configs must not be used. Responses
// also carry Cache-Control: no-store.

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIFetchError,
  SchemaType,
  type GenerationConfig,
  type ResponseSchema,
} from '@google/generative-ai';
import { MAX_FIRST_ACTIONS, isStealth, planFacts, stealthViolations, validatePlan } from '@/lib/responsePlan';
import { UNIT_TYPES, type PlanErrorCode, type PlanRequest, type PlanResponse } from '@/types/responsePlan';

const TIMEOUT_MS = 30_000;
/** Lets the platform (e.g. Vercel) run this function past the 30 s Gemini timeout, so it can still answer 504. */
export const maxDuration = 35;

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
/**
 * Gemini 3.x thinking level. "minimal" is near-off and fastest; some models reject it
 * (gemini-3.8-flash's minimum is "low"), so it can be overridden with GEMINI_THINKING_LEVEL.
 */
const DEFAULT_THINKING_LEVEL = 'minimal';

const SYSTEM_PROMPT = `You draft response plans for a campus emergency dispatcher; a human reviews every plan.
1. Use only facts in the input. Never invent floors, rooms, suspects, weapons, injuries, people counts, unit names or unit numbers. Anything needed but missing goes in "unknowns".
2. If sceneVerified is false, say in "approach" that the scene is unverified and add a caution.
3. If severityTier is "low": recommend review, not dispatch; "units" is empty; the first action is reviewing the alert.
4. callerMedicalProfile belongs to the caller (whose phone sent the SOS). Apply it to the person in distress only if the brief and sceneSummary do not indicate someone else. Otherwise call it "caller's profile", never apply it to the other person, and add "Patient's medical history" to "unknowns". Never call the caller "patient" unless they are clearly the one in distress.
5. If callerDevice is present (stealth mode), never suggest calling, texting, messaging or alerting the caller, or anything that makes their phone ring, vibrate, light up or sound; add a stealth-mode caution.
6. Cautions come only from building notes, callerMedicalProfile, callerDevice and explicit statements in the brief or sceneSummary. Always include the caller's conditions, allergies and medications as cautions, labelled as the caller's.
7. At most ${MAX_FIRST_ACTIONS} firstActions, in order. Every item and unit reason under 20 words; "approach" one or two short sentences.`;

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    units: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: { type: SchemaType.STRING, format: 'enum', enum: [...UNIT_TYPES] },
          reason: { type: SchemaType.STRING },
        },
        required: ['type', 'reason'],
      },
    },
    approach: { type: SchemaType.STRING },
    equipment: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    cautions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    firstActions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: MAX_FIRST_ACTIONS },
    unknowns: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['units', 'approach', 'equipment', 'cautions', 'firstActions', 'unknowns'],
};

const STATUS: Record<PlanErrorCode, number> = {
  bad_request: 400,
  missing_key: 503,
  rate_limited: 429,
  timeout: 504,
  invalid_output: 502,
  upstream: 502,
};

function reply(body: PlanResponse): Response {
  return Response.json(body, {
    status: body.ok ? 200 : STATUS[body.error],
    headers: { 'Cache-Control': 'no-store' },
  });
}

const fail = (error: PlanErrorCode, message: string) => reply({ ok: false, error, message });

function parseRequest(body: unknown): PlanRequest | null {
  const b = body as Partial<PlanRequest> | null;
  const i = b?.incident;
  if (!i || typeof i._id !== 'string' || typeof i.severityScore !== 'number' || typeof i.crisisType !== 'string') return null;
  if (!i.iceProfile || !i.gps || typeof i.dispatcherBrief !== 'string') return null;
  const other = Number(b?.otherOpenInBuilding ?? 0);
  return { incident: i, building: b?.building ?? null, otherOpenInBuilding: Number.isFinite(other) && other >= 0 ? other : 0 };
}

export async function POST(request: Request): Promise<Response> {
  let input: PlanRequest | null;
  try {
    input = parseRequest(await request.json());
  } catch {
    input = null;
  }
  if (!input) return fail('bad_request', 'Body must be { incident, building, otherOpenInBuilding } with a valid incident.');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail('missing_key', 'GEMINI_API_KEY is not set on the server.');
  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  // thinkingConfig is a Gemini API field the 0.24.1 SDK has no type for; the SDK sends
  // generationConfig through unchanged (an invalid level is rejected by the API with a 400).
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
  const facts = planFacts(input.incident, input.building, input.otherOpenInBuilding);

  let text: string;
  try {
    const result = await model.generateContent(JSON.stringify(facts), {
      timeout: TIMEOUT_MS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = result.response.text();
  } catch (err) {
    const name = (err as Error)?.name;
    if (err instanceof GoogleGenerativeAIAbortError || name === 'TimeoutError' || name === 'AbortError') {
      return fail('timeout', `Gemini did not answer within ${TIMEOUT_MS / 1000} s.`);
    }
    if (err instanceof GoogleGenerativeAIFetchError && err.status === 429) {
      return fail('rate_limited', `Gemini quota or rate limit reached for ${modelName}.`);
    }
    if (err instanceof GoogleGenerativeAIFetchError) {
      return fail('upstream', `Gemini request failed (${err.status ?? 'network'}${err.statusText ? ` ${err.statusText}` : ''}).`);
    }
    return fail('upstream', 'Gemini request failed.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('invalid_output', 'Gemini returned output that is not valid JSON.');
  }
  const checked = validatePlan(parsed);
  if ('problems' in checked) {
    return fail('invalid_output', `Gemini output did not match the plan format: ${checked.problems.slice(0, 3).join('; ')}.`);
  }
  // Safety net behind rule 5: never show a plan that would expose a hiding caller.
  if (isStealth(input.incident)) {
    const unsafe = stealthViolations(checked.plan);
    if (unsafe.length) {
      return fail('invalid_output', `Gemini suggested contacting a caller in stealth mode ("${unsafe[0]}"); plan withheld.`);
    }
  }

  return reply({
    ok: true,
    plan: checked.plan,
    model: modelName,
    generatedAt: new Date().toISOString(),
    shortened: checked.shortened,
  });
}
