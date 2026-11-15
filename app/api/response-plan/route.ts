// POST /api/response-plan: drafts a dispatcher's working notes for one incident with Gemini.
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
import {
  MAX_ACTIONS,
  MAX_RISKS,
  MAX_UNKNOWNS,
  availableSources,
  isStealth,
  planFacts,
  profileTerms,
  situationLine,
  validatePlan,
} from '@/lib/responsePlan';
import { PLAN_SOURCES, type PlanErrorCode, type PlanRequest, type PlanResponse } from '@/types/responsePlan';

const TIMEOUT_MS = 30_000;
/** Lets the platform (e.g. Vercel) run this function past the 30 s Gemini timeout, so it can still answer 504. */
export const maxDuration = 35;

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
/**
 * Gemini 3.x thinking level. "minimal" is near-off and fastest; some models reject it
 * (gemini-3.8-flash's minimum is "low"), so it can be overridden with GEMINI_THINKING_LEVEL.
 */
const DEFAULT_THINKING_LEVEL = 'minimal';

const SYSTEM_PROMPT = `You turn one incident's data into a campus dispatcher's working notes. Be specific to THIS incident; the dispatcher already knows standard procedure.
Output:
- radioBrief: at most 2 short sentences of plain spoken English to read over the radio: what is happening, where (building name), how many callers, and the key hazard. No IDs, no jargon.
- risks: at most ${MAX_RISKS}, most important first. Each risk states its consequence for responders or the caller (what could go wrong, be delayed or be missed). A fact with no consequence, such as which way an entrance faces, is not a risk; use it in an action or leave it out.
- actions: at most ${MAX_ACTIONS} imperative steps, in order.
- unknowns: at most ${MAX_UNKNOWNS} short questions about the scene, most important first: location, people involved, hazards, what is happening. Never ask about or speculate from the caller's medical profile.
Rules:
1. Every risk and action must come from one specific fact in the input and set "source" to the input key it came from: buildingNotes, callerProfile, callerDevice, perception, triage, timeline or otherCallers.
2. Leave out anything that would apply to any incident of this type: protective gear, radios, perimeters, staging, "use caution", "dispatch units". Fewer items is better than generic ones.
3. Use only the input. Never invent floors, rooms, suspects, weapons, injuries, people counts or unit names; put what is missing in unknowns.
4. If sceneStatus is present, include it in radioBrief.
5. If severityTier is "low", the first action is to review the alert; recommend review, not dispatch.
6. callerProfile belongs to the caller (whose phone sent the SOS). Use it for the person in distress only if triage and perception do not indicate someone else; otherwise call it the caller's and ask about the patient's history in unknowns. Never call the caller "patient" unless they are clearly the one in distress. Mention the profile only if it changes what responders do.
7. If callerDevice is present (stealth mode), never suggest calling, ringing, vibrating, flashing or audible alerts. Silent on-screen dispatcher messages are allowed. Tag any item about stealth mode with source callerDevice, not callerProfile.
8. Each risk, action and unknown under 20 words.`;

const ITEM: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    text: { type: SchemaType.STRING },
    source: { type: SchemaType.STRING, format: 'enum', enum: [...PLAN_SOURCES] },
  },
  required: ['text', 'source'],
};

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    radioBrief: { type: SchemaType.STRING },
    risks: { type: SchemaType.ARRAY, items: ITEM, maxItems: MAX_RISKS },
    actions: { type: SchemaType.ARRAY, items: ITEM, maxItems: MAX_ACTIONS },
    unknowns: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: MAX_UNKNOWNS },
  },
  required: ['radioBrief', 'risks', 'actions', 'unknowns'],
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

/** Accepts both the current dashboard Incident and main's (optional gps, nullable iceProfile). */
function parseRequest(body: unknown): PlanRequest | null {
  const b = body as Partial<PlanRequest> | null;
  const i = b?.incident;
  if (!i || typeof i._id !== 'string' || typeof i.severityScore !== 'number' || typeof i.crisisType !== 'string') return null;
  if (typeof i.dispatcherBrief !== 'string' || typeof i.createdAt !== 'string') return null;
  const otherCallers = Array.isArray(b?.otherCallers)
    ? b.otherCallers.filter((o) => o && typeof o.createdAt === 'string' && typeof o.severityScore === 'number')
    : [];
  return { incident: { ...i, iceProfile: i.iceProfile ?? null }, building: b?.building ?? null, otherCallers };
}

export async function POST(request: Request): Promise<Response> {
  let input: PlanRequest | null;
  try {
    input = parseRequest(await request.json());
  } catch {
    input = null;
  }
  if (!input) return fail('bad_request', 'Body must be { incident, building, otherCallers } with a valid incident.');

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
  const facts = planFacts(input.incident, input.building, input.otherCallers);

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
  // Drops items with a source missing from the input, generic advice, "verified" claims and
  // anything that would expose a caller in stealth mode; rejects only structurally broken output.
  const checked = validatePlan(parsed, availableSources(facts), {
    stealth: isStealth(input.incident),
    unverified: input.incident.lowBandwidth || Boolean(input.incident.classificationFailed),
    profileTerms: profileTerms(input.incident),
  });
  if ('problems' in checked) {
    return fail('invalid_output', `Gemini output did not match the plan format: ${checked.problems.slice(0, 3).join('; ')}.`);
  }
  // Exact counts and times come from the input, not the model.
  checked.plan.situation = situationLine(input.incident, input.building, input.otherCallers);

  return reply({
    ok: true,
    plan: checked.plan,
    model: modelName,
    generatedAt: new Date().toISOString(),
    shortened: checked.shortened,
    dropped: checked.dropped,
  });
}
