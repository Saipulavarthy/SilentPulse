import type { Building, CrisisType, IceProfile, Trend } from "@/types/incident";
import { VICTIM_INSTRUCTIONS } from "@/types/incident";
import { withTimeout } from "@/lib/ai/media";

/** Richer JSON (reasons/trend/instructions) needs a bit more headroom; keep total triage ≪ 30s. */
export const GROK_TIMEOUT_MS = 18_000;

const TRENDS: Trend[] = ["new", "worsening", "stable", "improving"];

export type GrokHistoryEntry = {
  ts: string;
  crisisType: string;
  severityScore: number;
  sceneSummary?: string;
};

export type GrokTriageResult = {
  severityScore: number;
  trend: Trend;
  reasons: string[];
  dispatcherBrief: string;
  victimInstructions: string[];
};

function clampSeverity(score: unknown): number {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return 8;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function cleanStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseTrend(value: unknown): Trend {
  if (typeof value === "string" && (TRENDS as string[]).includes(value)) {
    return value as Trend;
  }
  return "new";
}

function staticInstructions(crisisType: CrisisType): string[] {
  const raw = VICTIM_INSTRUCTIONS[crisisType] ?? VICTIM_INSTRUCTIONS.UNKNOWN;
  return raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** ACTIVE_THREAT instructions must be silent actions only. */
function sanitizeThreatInstructions(steps: string[]): string[] {
  const noisy =
    /\b(call out|shout|scream|yell|make noise|whistle|bang|knock loudly|cry for help)\b/i;
  const filtered = steps.filter((s) => !noisy.test(s));
  if (filtered.length > 0) return filtered.slice(0, 3);
  return [
    "Silence your phone completely.",
    "Hide and barricade if possible.",
    "Do not confront the threat.",
  ];
}

export async function gradeWithGrok(input: {
  crisisType: CrisisType;
  lowBandwidth: boolean;
  gps?: { lat: number; lng: number };
  iceSummary: string;
  iceProfile: IceProfile | null;
  sceneSummary?: string;
  cues: string[];
  simulated: boolean;
  building?: Building | null;
  history: GrokHistoryEntry[];
  previousSeverityScore?: number;
}): Promise<GrokTriageResult> {
  const gpsLabel = input.gps
    ? `${input.gps.lat}, ${input.gps.lng}`
    : "GPS unavailable";
  const fallbackBrief = `SOS at ${gpsLabel} classified as ${input.crisisType}. Units should respond immediately; full AI triage unavailable.`;
  const fallback: GrokTriageResult = {
    severityScore: 8,
    trend: input.history.length > 0 ? "stable" : "new",
    reasons: [],
    dispatcherBrief: fallbackBrief,
    victimInstructions: staticInstructions(input.crisisType),
  };

  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GROK_API_KEY missing; using severity fallback");
    return fallback;
  }

  try {
    const systemPrompt = [
      "You are SilentPulse emergency triage. Respond with ONLY valid JSON.",
      'Schema: { "severityScore": integer 1-10, "trend": "new"|"worsening"|"stable"|"improving", "reasons": string[2-4], "dispatcherBrief": string, "victimInstructions": string[2-3] }',
      "Severity rubric: 1-3 likely false alarm; 4-6 urgent, single unit; 7-8 critical hazard; 9-10 lethal threat or high-risk patient in a hazard.",
      'trend = "new" when there is no history; otherwise compare to prior ticks (worsening/stable/improving).',
      "dispatcherBrief must be exactly 2 concise sentences for a human dispatcher who CONFIRMS dispatch (your output is a RECOMMENDATION).",
      "When history exists, mention the trend in the brief. Call out medical red flags from ICE. Include building context if given.",
      "When a building is provided, factor in its floor count and notes: a fire in a multi-story building raises severity and the brief should say not to use elevators; for an active threat in a building, the brief should give floor/entry context. Never invent building details that aren't provided.",
      "reasons: 2-4 short strings linking evidence to risk (e.g. \"Severe asthma + smoke inhalation risk\", \"Deaf: cannot hear responders calling out\").",
      "victimInstructions: 2-3 imperative steps, max 12 words each, specific to the crisis AND the ICE profile (e.g. \"Use your albuterol inhaler now.\").",
      "For ACTIVE_THREAT, victimInstructions must be silent actions only (no \"call out\", no \"make noise\").",
      "Factor mobilityNotes and sensoryNotes into severity, reasons, and instructions.",
      "Elevate severity when medical conditions/allergies conflict with the crisis, or when lowBandwidth/UNKNOWN with a high-risk patient.",
    ].join(" ");

    const userPayload = {
      crisisType: input.crisisType,
      lowBandwidth: input.lowBandwidth,
      gps: input.gps ?? null,
      iceSummary: input.iceSummary,
      iceProfile: input.iceProfile,
      sceneSummary: input.sceneSummary ?? null,
      cues: input.cues,
      simulated: input.simulated,
      building: input.building ?? null,
      history: input.history,
      previousSeverityScore: input.previousSeverityScore ?? null,
    };

    const started = Date.now();
    const response = await withTimeout(
      fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-3-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Triage this SilentPulse SOS and return JSON only:\n${JSON.stringify(userPayload)}`,
            },
          ],
        }),
      }),
      GROK_TIMEOUT_MS,
      "Grok",
    );
    console.log(`[triage] Grok latency ${Date.now() - started}ms`);

    if (!response.ok) {
      const errText = await response.text();
      console.error("[triage] Grok HTTP error:", response.status, errText);
      return fallback;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return fallback;
    }

    const parsed = JSON.parse(content) as {
      severityScore?: unknown;
      trend?: unknown;
      reasons?: unknown;
      dispatcherBrief?: unknown;
      victimInstructions?: unknown;
    };

    const dispatcherBrief =
      typeof parsed.dispatcherBrief === "string" &&
      parsed.dispatcherBrief.trim().length > 0
        ? parsed.dispatcherBrief.trim()
        : fallback.dispatcherBrief;

    let victimInstructions = cleanStrings(parsed.victimInstructions, 3);
    if (victimInstructions.length === 0) {
      victimInstructions = staticInstructions(input.crisisType);
    }
    if (input.crisisType === "ACTIVE_THREAT") {
      victimInstructions = sanitizeThreatInstructions(victimInstructions);
    }

    const trend = parseTrend(parsed.trend);
    const reasons = cleanStrings(parsed.reasons, 4);

    return {
      severityScore: clampSeverity(parsed.severityScore),
      trend: input.history.length === 0 ? "new" : trend,
      reasons,
      dispatcherBrief,
      victimInstructions,
    };
  } catch (error) {
    console.error("[triage] Grok triage failed:", error);
    return fallback;
  }
}
