import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import type { CrisisType } from "@/types/incident";
import {
  isNonEmptyMedia,
  parseDataUri,
  resolveMediaMime,
  withTimeout,
} from "@/lib/ai/media";

export const GEMINI_TIMEOUT_MS = 20_000;

/** Same env override as /api/response-plan (`GEMINI_MODEL`). */
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const PERCEPTION_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
  "UNKNOWN",
] as const;

type PerceptionCrisisType = (typeof PERCEPTION_TYPES)[number];

export type GeminiClassifyResult = {
  crisisType: CrisisType;
  classificationFailed: boolean;
  sceneSummary?: string;
  cues: string[];
  rawModelText?: string;
};

const GEMINI_SYSTEM_INSTRUCTION = [
  "You are SilentPulse emergency scene classifier and scene describer.",
  "You will receive a camera still (and optionally audio) from a phone SOS.",
  "You MUST look at the image and listen to the audio before deciding.",
  "",
  "CRITICAL CLASSIFICATION RULES:",
  '1. THREAT OVERRIDE: If the audio contains explicit threat vocabulary ("don\'t shoot", "stop", "help me") OR the video shows defensive body language (hands raised, cowering), classify as ACTIVE_THREAT (SECURITY_THREAT) immediately.',
  '2. FIRE & ENTRAPMENT: If audio contains "fire", "smoke", "trapped", or alarms, OR video shows flames/smoke/entrapment, classify as ENVIRONMENTAL_HAZARD (FIRE_ENVIRONMENTAL).',
  "3. MEDICAL CRISIS: Require STRONG evidence. Only classify as MEDICAL_CRISIS if there is unmistakable heavy breathing, hyperventilating, crying, or visible physical distress/injury.",
  "4. SILENCE & AMBIENCE (STRICT FILTER): You must ignore background static, room hum, music, and empty rooms. Do NOT assume static or silence is heavy breathing.",
  "5. AMBIGUOUS / DEFAULT: If the user is just sitting there, if there is only silence/static, if the camera is blocked/black, or if there is no explicit sign of danger, you MUST classify as UNKNOWN (UNKNOWN_CRISIS).",
  "",
  "crisisType must be exactly one of: ENVIRONMENTAL_HAZARD, MEDICAL_CRISIS, ACTIVE_THREAT, UNKNOWN.",
  "",
  "Also describe the scene:",
  "- sceneSummary: one sentence covering what is seen AND heard.",
  "- cues: 2-5 short concrete observations (e.g. \"smoke haze\", \"smoke alarm tone\", \"rapid shallow breathing\", \"dark/covered frame\", \"whispering\").",
  "Describe only what is actually present; if the frame is dark or the audio is quiet, say so in cues.",
  "Respond with JSON only matching the schema.",
].join("\n");

const GEMINI_USER_PROMPT =
  "Analyze the attached camera frame and audio from this SilentPulse SOS. Apply the CRITICAL CLASSIFICATION RULES strictly. Return JSON with crisisType, sceneSummary, and cues. Prefer UNKNOWN when evidence is weak or ambient-only.";

const GEMINI_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    crisisType: {
      type: SchemaType.STRING,
      format: "enum",
      enum: [...PERCEPTION_TYPES],
    },
    sceneSummary: {
      type: SchemaType.STRING,
      description: "One sentence: what is seen AND heard",
    },
    cues: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "2-5 short concrete observations",
    },
  },
  required: ["crisisType", "sceneSummary", "cues"],
};

export function extractCrisisType(raw: string): PerceptionCrisisType | null {
  const upper = raw.toUpperCase();
  const embedded = upper.match(
    /\b(SECURITY_THREAT|FIRE_ENVIRONMENTAL|UNKNOWN_CRISIS|ENVIRONMENTAL_HAZARD|MEDICAL_CRISIS|ACTIVE_THREAT|UNKNOWN)\b/,
  );
  if (embedded) {
    return mapGeminiLabelToPerception(embedded[1]);
  }

  return mapGeminiLabelToPerception(upper.trim().replace(/[^A-Z_]/g, ""));
}

function mapGeminiLabelToPerception(
  label: string,
): PerceptionCrisisType | null {
  const normalized = label.toUpperCase().trim().replace(/[^A-Z_]/g, "");

  switch (normalized) {
    case "SECURITY_THREAT":
    case "ACTIVE_THREAT":
    case "THREAT":
    case "VIOLENT_THREAT":
    case "ASSAULT":
      return "ACTIVE_THREAT";
    case "FIRE_ENVIRONMENTAL":
    case "ENVIRONMENTAL_HAZARD":
    case "FIRE":
    case "HAZARD":
    case "ENVIRONMENTAL":
      return "ENVIRONMENTAL_HAZARD";
    case "MEDICAL_CRISIS":
    case "MEDICAL":
    case "PANIC_ATTACK":
    case "HEALTH_EMERGENCY":
      return "MEDICAL_CRISIS";
    case "UNKNOWN_CRISIS":
    case "UNKNOWN":
      return "UNKNOWN";
    default:
      return null;
  }
}

function cleanCues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 5);
}

export async function classifyWithGemini(
  imageBase64: string | undefined,
  audioBase64: string | undefined,
): Promise<GeminiClassifyResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GEMINI_API_KEY missing; classificationFailed");
    return { crisisType: "UNKNOWN", classificationFailed: true, cues: [] };
  }

  const modelName =
    process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: GEMINI_SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    });
    console.log("[triage] Gemini model:", modelName);

    const parts: Array<
      | { text: string }
      | { inlineData: { data: string; mimeType: string } }
    > = [{ text: GEMINI_USER_PROMPT }];

    if (isNonEmptyMedia(imageBase64)) {
      const parsed = parseDataUri(imageBase64!);
      if (parsed.data.length > 0) {
        parts.push({
          inlineData: {
            data: parsed.data,
            mimeType: resolveMediaMime(parsed.mimeType, "visual"),
          },
        });
      } else {
        console.warn("[triage] visual media present but base64 data is empty");
      }
    }

    if (isNonEmptyMedia(audioBase64)) {
      const parsed = parseDataUri(audioBase64!);
      if (parsed.data.length > 0) {
        const mime = resolveMediaMime(
          parsed.mimeType.split(";")[0] || parsed.mimeType,
          "audio",
        );
        parts.push({
          inlineData: {
            data: parsed.data,
            mimeType: mime,
          },
        });
      } else {
        console.warn("[triage] audio media present but base64 data is empty");
      }
    }

    console.log(
      "[triage] Gemini part summary:",
      parts.map((p) =>
        "text" in p
          ? { kind: "text", chars: p.text.length }
          : {
              kind: "inlineData",
              mimeType: p.inlineData.mimeType,
              dataChars: p.inlineData.data.length,
            },
      ),
    );

    const mediaPartCount = parts.filter((p) => "inlineData" in p).length;
    if (mediaPartCount === 0) {
      console.warn("[triage] no usable media parts after parse; skipping Gemini");
      return { crisisType: "UNKNOWN", classificationFailed: true, cues: [] };
    }

    const started = Date.now();
    const result = await withTimeout(
      model.generateContent({ contents: [{ role: "user", parts }] }),
      GEMINI_TIMEOUT_MS,
      "Gemini",
    );
    console.log(`[triage] Gemini latency ${Date.now() - started}ms`);

    const candidate = result.response.candidates?.[0];
    console.log("[triage] Gemini finishReason:", candidate?.finishReason);

    let text = "";
    try {
      text = result.response.text() ?? "";
    } catch (textErr) {
      console.warn("[triage] response.text() threw:", textErr);
    }
    if (!text.trim() && candidate?.content?.parts) {
      text = candidate.content.parts
        .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim();
    }

    console.log("[triage] Gemini raw classification:", text.slice(0, 400));

    try {
      const parsed = JSON.parse(text) as {
        crisisType?: unknown;
        sceneSummary?: unknown;
        cues?: unknown;
      };
      const crisisType =
        typeof parsed.crisisType === "string"
          ? extractCrisisType(parsed.crisisType)
          : null;
      if (!crisisType) {
        throw new Error("missing/invalid crisisType in JSON");
      }
      const sceneSummary =
        typeof parsed.sceneSummary === "string" &&
        parsed.sceneSummary.trim().length > 0
          ? parsed.sceneSummary.trim()
          : undefined;
      return {
        crisisType,
        classificationFailed: false,
        sceneSummary,
        cues: cleanCues(parsed.cues),
        rawModelText: text,
      };
    } catch {
      const extracted = extractCrisisType(text);
      if (!extracted) {
        console.warn(
          "[triage] could not parse Gemini label from:",
          text.slice(0, 200),
        );
        return {
          crisisType: "UNKNOWN",
          classificationFailed: true,
          cues: [],
          rawModelText: text,
        };
      }
      return {
        crisisType: extracted,
        classificationFailed: false,
        cues: [],
        sceneSummary: undefined,
        rawModelText: text,
      };
    }
  } catch (error) {
    console.error("[triage] Gemini classification failed:", error);
    return { crisisType: "UNKNOWN", classificationFailed: true, cues: [] };
  }
}
