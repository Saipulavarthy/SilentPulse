import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { IceProfile } from "@/models/IceProfile";
import {
  ActiveIncident,
  CRISIS_TYPES,
  type CrisisType,
} from "@/models/Incident";

type TriageRequestBody = {
  userId?: string;
  gps?: {
    lat?: number;
    lng?: number;
  };
  imageBase64?: string;
  audioBase64?: string;
};

type GrokTriageResult = {
  severityScore: number;
  dispatcherBrief: string;
};

const PERCEPTION_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
] as const;

type PerceptionCrisisType = (typeof PERCEPTION_TYPES)[number];

const GEMINI_CLASSIFY_PROMPT =
  "You must respond with ONLY ONE of these three exact strings: ENVIRONMENTAL_HAZARD, MEDICAL_CRISIS, or ACTIVE_THREAT. Do not include any other text, markdown, or punctuation.";

function isNonEmptyMedia(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDataUri(input: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "application/octet-stream", data: input.trim() };
}

function sanitizeCrisisType(raw: string): PerceptionCrisisType {
  const normalized = raw.trim().toUpperCase();
  if (
    (PERCEPTION_TYPES as readonly string[]).includes(normalized)
  ) {
    return normalized as PerceptionCrisisType;
  }
  return "ACTIVE_THREAT";
}

function clampSeverity(score: unknown): number {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return 8;
  return Math.min(10, Math.max(1, Math.round(n)));
}

async function classifyWithGemini(
  imageBase64: string | undefined,
  audioBase64: string | undefined,
): Promise<PerceptionCrisisType> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GEMINI_API_KEY missing; falling back to ACTIVE_THREAT");
    return "ACTIVE_THREAT";
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const parts: Array<
      | { text: string }
      | { inlineData: { data: string; mimeType: string } }
    > = [{ text: GEMINI_CLASSIFY_PROMPT }];

    if (isNonEmptyMedia(imageBase64)) {
      const parsed = parseDataUri(imageBase64!);
      parts.push({
        inlineData: {
          data: parsed.data,
          mimeType:
            parsed.mimeType === "application/octet-stream"
              ? "image/jpeg"
              : parsed.mimeType,
        },
      });
    }

    if (isNonEmptyMedia(audioBase64)) {
      const parsed = parseDataUri(audioBase64!);
      parts.push({
        inlineData: {
          data: parsed.data,
          mimeType:
            parsed.mimeType === "application/octet-stream"
              ? "audio/webm"
              : parsed.mimeType,
        },
      });
    }

    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
    });
    const text = result.response.text() ?? "";
    return sanitizeCrisisType(text);
  } catch (error) {
    console.error("[triage] Gemini classification failed:", error);
    return "ACTIVE_THREAT";
  }
}

async function gradeWithGrok(input: {
  crisisType: CrisisType;
  isLowBandwidth: boolean;
  gps: { lat: number; lng: number };
  iceSummary: string;
  iceProfile: {
    bloodType?: string;
    allergies: string[];
    conditions: string[];
    medications: string[];
  } | null;
}): Promise<GrokTriageResult> {
  const fallback: GrokTriageResult = {
    severityScore: 8,
    dispatcherBrief: `SOS at GPS ${input.gps.lat}, ${input.gps.lng} classified as ${input.crisisType}. Units should respond immediately; full AI triage unavailable.`,
  };

  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GROK_API_KEY missing; using severity fallback");
    return fallback;
  }

  try {
    const systemPrompt = [
      "You are SilentPulse emergency triage. Respond with ONLY valid JSON.",
      'Schema: { "severityScore": integer 1-10, "dispatcherBrief": string }',
      "dispatcherBrief must be exactly 2 concise, high-signal sentences for an emergency dispatcher.",
      "Elevate severityScore when medical conditions/allergies conflict with the crisis,",
      "or when LOW_BANDWIDTH_SOS is triggered for a high-risk patient.",
    ].join(" ");

    const userPayload = {
      crisisType: input.crisisType,
      isLowBandwidth: input.isLowBandwidth,
      gps: input.gps,
      iceSummary: input.iceSummary,
      iceProfile: input.iceProfile,
    };

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
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
    });

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
      dispatcherBrief?: unknown;
    };

    const dispatcherBrief =
      typeof parsed.dispatcherBrief === "string" &&
      parsed.dispatcherBrief.trim().length > 0
        ? parsed.dispatcherBrief.trim()
        : fallback.dispatcherBrief;

    return {
      severityScore: clampSeverity(parsed.severityScore),
      dispatcherBrief,
    };
  } catch (error) {
    console.error("[triage] Grok triage failed:", error);
    return fallback;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TriageRequestBody;
    const { userId, gps, imageBase64, audioBase64 } = body;

    if (
      !userId ||
      typeof userId !== "string" ||
      typeof gps?.lat !== "number" ||
      typeof gps?.lng !== "number" ||
      Number.isNaN(gps.lat) ||
      Number.isNaN(gps.lng)
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid request. Required: userId (string) and gps.lat / gps.lng (numbers).",
        },
        { status: 400 },
      );
    }

    await connectToDatabase();

    const profile = await IceProfile.findOne({ userId }).lean();
    const iceSummary = profile
      ? [
          `Blood type: ${profile.bloodType ?? "unknown"}`,
          `Allergies: ${(profile.allergies ?? []).join(", ") || "none"}`,
          `Conditions: ${(profile.conditions ?? []).join(", ") || "none"}`,
          `Medications: ${(profile.medications ?? []).join(", ") || "none"}`,
        ].join("; ")
      : "No ICE medical profile on file";

    const hasMedia =
      isNonEmptyMedia(imageBase64) || isNonEmptyMedia(audioBase64);
    const isLowBandwidth = !hasMedia;

    let crisisType: CrisisType;
    if (isLowBandwidth) {
      crisisType = "LOW_BANDWIDTH_SOS";
    } else {
      crisisType = await classifyWithGemini(imageBase64, audioBase64);
    }

    if (!(CRISIS_TYPES as readonly string[]).includes(crisisType)) {
      crisisType = "ACTIVE_THREAT";
    }

    const { severityScore, dispatcherBrief } = await gradeWithGrok({
      crisisType,
      isLowBandwidth,
      gps: { lat: gps.lat, lng: gps.lng },
      iceSummary,
      iceProfile: profile
        ? {
            bloodType: profile.bloodType ?? undefined,
            allergies: profile.allergies ?? [],
            conditions: profile.conditions ?? [],
            medications: profile.medications ?? [],
          }
        : null,
    });

    const incident = await ActiveIncident.create({
      userId,
      crisisType,
      severityScore,
      dispatcherBrief,
      gps: { lat: gps.lat, lng: gps.lng },
      isLowBandwidth,
    });

    return NextResponse.json(
      {
        incidentId: incident._id.toString(),
        crisisType,
        severityScore,
        dispatcherBrief,
        isLowBandwidth,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[triage] unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
