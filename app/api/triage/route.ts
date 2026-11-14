import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { iceFromPhone } from "@/lib/iceFromPhone";
import { connectToDatabase } from "@/lib/mongodb";
import { serializeIncident } from "@/lib/serializeIncident";
import { IceProfile } from "@/models/IceProfile";
import {
  ActiveIncident,
  CRISIS_TYPES,
  type CrisisType,
} from "@/models/Incident";
import type {
  IceProfile as IceProfileShape,
  SimulateCrisisType,
  TriageRequest,
} from "@/types/incident";
import { VICTIM_INSTRUCTIONS } from "@/types/incident";

/** Vercel / Next route segment: allow full Gemini+Grok budget. */
export const maxDuration = 60;

type GrokTriageResult = {
  severityScore: number;
  dispatcherBrief: string;
};

type ClassifyResult = {
  crisisType: CrisisType;
  classificationFailed: boolean;
  rawModelText?: string;
};

const GEMINI_TIMEOUT_MS = 20_000;
const GROK_TIMEOUT_MS = 12_000;

const PERCEPTION_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
] as const;

type PerceptionCrisisType = (typeof PERCEPTION_TYPES)[number];

const GEMINI_SYSTEM_INSTRUCTION = [
  "You are SilentPulse emergency scene classifier.",
  "You will receive a camera still (and optionally audio) from a phone SOS.",
  "You MUST look at the image and listen to the audio before deciding.",
  "",
  "Choose exactly ONE label:",
  "- ENVIRONMENTAL_HAZARD: fire, smoke, flood, gas, chemical spill, structural collapse, severe weather damage, visible environmental danger.",
  "- MEDICAL_CRISIS: injury, collapse, seizure, chest pain, overdose, unconsciousness, choking, panic attack, heavy breathing, crying, hyperventilating, medical distress with NO clear attacker in frame.",
  "- ACTIVE_THREAT: weapon, assault, physical attacker, hostage situation, or clear violent threat visible/audible. Do NOT use this for panic breathing alone.",
  "",
  "Critical rule: If the audio detects heavy breathing, crying, hyperventilating, or panic, you must classify it as a MEDICAL_CRISIS unless the video frames explicitly show a physical attacker.",
  "A dark, covered or obstructed frame combined with whispering, shouting, banging, screaming or gunshot-like sounds indicates a person hiding from a threat → ACTIVE_THREAT.",
  "Do not default to ACTIVE_THREAT. If evidence is ambiguous between medical and threat, prefer MEDICAL_CRISIS (unless the dark/obstructed + threat-sound rule applies).",
  "If evidence is ambiguous between medical and environmental, prefer the clearer visual cue; if still unclear, prefer MEDICAL_CRISIS.",
  "",
  "Final answer format: respond with ONLY one of these exact strings and nothing else:",
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
].join("\n");

const GEMINI_USER_PROMPT =
  "Analyze the attached camera frame and audio from this SilentPulse SOS. Classify the scenario using the system rules. Reply with exactly one label.";

function isNonEmptyMedia(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isSimulateCrisisType(value: unknown): value is SimulateCrisisType {
  return (
    typeof value === "string" &&
    (PERCEPTION_TYPES as readonly string[]).includes(value)
  );
}

/** Accepts data URIs with optional charset / extra params before ;base64, */
function parseDataUri(input: string): { mimeType: string; data: string } {
  const trimmed = input.trim();
  const match =
    /^data:([^;,]+)(?:;charset=[^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(
      trimmed,
    );
  if (match) {
    return {
      mimeType: match[1],
      data: match[2].replace(/\s/g, ""),
    };
  }
  return {
    mimeType: "application/octet-stream",
    data: trimmed.replace(/\s/g, ""),
  };
}

/**
 * Preserve real audio/video MIME types from the phone.
 * Never force image/jpeg onto webm/mp4 — Gemini 400s on that mismatch.
 */
function resolveMediaMime(
  parsedMime: string,
  slot: "visual" | "audio",
): string {
  const mt = (parsedMime || "").toLowerCase().trim();
  if (mt.startsWith("audio/")) return mt;
  if (mt.startsWith("video/")) return mt;
  if (mt.startsWith("image/") && slot === "visual") return mt;

  if (slot === "audio") {
    if (mt.includes("webm")) return "audio/webm";
    if (mt.includes("ogg")) return "audio/ogg";
    if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) {
      return "audio/mp4";
    }
    if (mt.includes("mpeg") || mt.includes("mp3")) return "audio/mpeg";
    if (mt.includes("wav")) return "audio/wav";
    return "audio/webm";
  }

  if (mt.includes("webm")) return "video/webm";
  if (mt.includes("mp4")) return "video/mp4";
  if (mt.includes("png")) return "image/png";
  if (mt.includes("webp")) return "image/webp";
  if (mt.includes("gif")) return "image/gif";
  return "image/jpeg";
}

function extractCrisisType(raw: string): PerceptionCrisisType | null {
  const upper = raw.toUpperCase();
  const embedded = upper.match(
    /\b(ENVIRONMENTAL_HAZARD|MEDICAL_CRISIS|ACTIVE_THREAT)\b/,
  );
  if (embedded) return embedded[1] as PerceptionCrisisType;

  let normalized = upper.trim().replace(/[^A-Z_]/g, "");
  if (
    normalized === "SECURITY_THREAT" ||
    normalized === "THREAT" ||
    normalized === "VIOLENT_THREAT" ||
    normalized === "ASSAULT"
  ) {
    normalized = "ACTIVE_THREAT";
  }
  if (
    normalized === "MEDICAL" ||
    normalized === "PANIC_ATTACK" ||
    normalized === "HEALTH_EMERGENCY"
  ) {
    normalized = "MEDICAL_CRISIS";
  }
  if (
    normalized === "FIRE" ||
    normalized === "HAZARD" ||
    normalized === "ENVIRONMENTAL"
  ) {
    normalized = "ENVIRONMENTAL_HAZARD";
  }
  if ((PERCEPTION_TYPES as readonly string[]).includes(normalized)) {
    return normalized as PerceptionCrisisType;
  }
  return null;
}

function clampSeverity(score: unknown): number {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return 8;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function parseOptionalGps(
  gps: TriageRequest["gps"],
): { lat: number; lng: number } | undefined {
  if (
    typeof gps?.lat === "number" &&
    typeof gps?.lng === "number" &&
    !Number.isNaN(gps.lat) &&
    !Number.isNaN(gps.lng)
  ) {
    return { lat: gps.lat, lng: gps.lng };
  }
  return undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summarizeIce(profile: IceProfileShape | null): string {
  if (!profile) return "No ICE medical profile on file";
  return [
    `Name: ${profile.name ?? "unknown"}`,
    profile.age !== undefined ? `Age: ${profile.age}` : null,
    `Blood type: ${profile.bloodType ?? "unknown"}`,
    `Allergies: ${(profile.allergies ?? []).join(", ") || "none"}`,
    `Conditions: ${(profile.conditions ?? []).join(", ") || "none"}`,
    `Medications: ${(profile.medications ?? []).join(", ") || "none"}`,
    `Mobility notes: ${profile.mobilityNotes ?? "none"}`,
    `Sensory notes: ${profile.sensoryNotes ?? "none"}`,
    profile.emergencyContact
      ? `Emergency contact: ${profile.emergencyContact.name ?? "n/a"} ${profile.emergencyContact.phone ?? ""}`.trim()
      : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function leanToIceShape(
  doc: {
    name?: string | null;
    age?: number | null;
    bloodType?: string | null;
    allergies?: string[] | null;
    conditions?: string[] | null;
    medications?: string[] | null;
    emergencyContact?: {
      name?: string | null;
      phone?: string | null;
      relation?: string | null;
    } | null;
    mobilityNotes?: string | null;
    sensoryNotes?: string | null;
  } | null,
): IceProfileShape | null {
  if (!doc) return null;
  return {
    ...(doc.name ? { name: doc.name } : {}),
    ...(typeof doc.age === "number" ? { age: doc.age } : {}),
    ...(doc.bloodType ? { bloodType: doc.bloodType } : {}),
    allergies: doc.allergies ?? [],
    conditions: doc.conditions ?? [],
    medications: doc.medications ?? [],
    ...(doc.mobilityNotes ? { mobilityNotes: doc.mobilityNotes } : {}),
    ...(doc.sensoryNotes ? { sensoryNotes: doc.sensoryNotes } : {}),
    ...(doc.emergencyContact
      ? {
          emergencyContact: {
            ...(doc.emergencyContact.name
              ? { name: doc.emergencyContact.name }
              : {}),
            ...(doc.emergencyContact.phone
              ? { phone: doc.emergencyContact.phone }
              : {}),
            ...(doc.emergencyContact.relation
              ? { relation: doc.emergencyContact.relation }
              : {}),
          },
        }
      : {}),
  };
}

function triageJsonResponse(serialized: ReturnType<typeof serializeIncident>) {
  return NextResponse.json(
    {
      incidentId: serialized._id,
      sessionId: serialized.sessionId,
      classification: serialized.crisisType,
      dispatcherStatus: serialized.dispatcherStatus,
      crisisType: serialized.crisisType,
      severityScore: serialized.severityScore,
      dispatcherBrief: serialized.dispatcherBrief,
      lowBandwidth: serialized.lowBandwidth,
      classificationFailed: serialized.classificationFailed,
      simulated: serialized.simulated,
      victimInstructions: serialized.victimInstructions,
      iceProfile: serialized.iceProfile,
      updateCount: serialized.updateCount,
      timeline: serialized.timeline,
      lastSeenAt: serialized.lastSeenAt,
      incident: serialized,
    },
    { status: 200 },
  );
}

async function classifyWithGemini(
  imageBase64: string | undefined,
  audioBase64: string | undefined,
): Promise<ClassifyResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GEMINI_API_KEY missing; classificationFailed");
    return { crisisType: "UNKNOWN", classificationFailed: true };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: GEMINI_SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
    });

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
      return { crisisType: "UNKNOWN", classificationFailed: true };
    }

    const result = await withTimeout(
      model.generateContent({ contents: [{ role: "user", parts }] }),
      GEMINI_TIMEOUT_MS,
      "Gemini",
    );

    const candidate = result.response.candidates?.[0];
    console.log("[triage] Gemini finishReason:", candidate?.finishReason);
    console.log(
      "[triage] Gemini promptFeedback:",
      JSON.stringify(result.response.promptFeedback ?? null),
    );

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

    console.log("[triage] Gemini raw classification:", JSON.stringify(text));
    const extracted = extractCrisisType(text);
    if (!extracted) {
      console.warn(
        "[triage] could not parse Gemini label from:",
        text.slice(0, 200),
      );
      return {
        crisisType: "UNKNOWN",
        classificationFailed: true,
        rawModelText: text,
      };
    }
    return {
      crisisType: extracted,
      classificationFailed: false,
      rawModelText: text,
    };
  } catch (error) {
    console.error("[triage] Gemini classification failed:", error);
    return { crisisType: "UNKNOWN", classificationFailed: true };
  }
}

async function gradeWithGrok(input: {
  crisisType: CrisisType;
  lowBandwidth: boolean;
  gps?: { lat: number; lng: number };
  iceSummary: string;
  iceProfile: IceProfileShape | null;
}): Promise<GrokTriageResult> {
  const gpsLabel = input.gps
    ? `${input.gps.lat}, ${input.gps.lng}`
    : "GPS unavailable";
  const fallback: GrokTriageResult = {
    severityScore: 8,
    dispatcherBrief: `SOS at ${gpsLabel} classified as ${input.crisisType}. Units should respond immediately; full AI triage unavailable.`,
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
      "or when crisisType is UNKNOWN / lowBandwidth is true for a high-risk patient.",
      "Mention relevant ICE conditions (e.g. asthma, diabetes) when present.",
      "Factor mobilityNotes and sensoryNotes into the brief and severity:",
      "e.g. a deaf user cannot hear responders calling out; a wheelchair user cannot use stairs.",
      "If sensoryNotes or mobilityNotes are present, at least one sentence must call out that operational constraint.",
    ].join(" ");

    const userPayload = {
      crisisType: input.crisisType,
      lowBandwidth: input.lowBandwidth,
      gps: input.gps ?? null,
      iceSummary: input.iceSummary,
      iceProfile: input.iceProfile,
    };

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

async function resolveIceProfile(
  userId: string,
  phoneIce: TriageRequest["iceProfile"],
): Promise<IceProfileShape | null> {
  const existing = await IceProfile.findOne({ userId }).lean();
  const fromPhone = iceFromPhone(phoneIce);

  let profileForTriage: IceProfileShape | null = leanToIceShape(existing);

  if (fromPhone) {
    const merged: IceProfileShape = {
      name: fromPhone.name ?? existing?.name ?? undefined,
      age: fromPhone.age ?? existing?.age ?? undefined,
      bloodType: fromPhone.bloodType ?? existing?.bloodType ?? undefined,
      conditions: fromPhone.conditions,
      allergies: fromPhone.allergies,
      medications: existing?.medications ?? [],
      mobilityNotes:
        fromPhone.mobilityNotes ?? existing?.mobilityNotes ?? undefined,
      sensoryNotes:
        fromPhone.sensoryNotes ?? existing?.sensoryNotes ?? undefined,
      emergencyContact:
        fromPhone.emergencyContact ??
        leanToIceShape(existing)?.emergencyContact,
    };

    const upserted = await IceProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          ...(merged.name !== undefined ? { name: merged.name } : {}),
          ...(merged.age !== undefined ? { age: merged.age } : {}),
          ...(merged.bloodType !== undefined
            ? { bloodType: merged.bloodType }
            : {}),
          conditions: merged.conditions,
          allergies: merged.allergies,
          medications: merged.medications ?? [],
          ...(merged.mobilityNotes !== undefined
            ? { mobilityNotes: merged.mobilityNotes }
            : {}),
          ...(merged.sensoryNotes !== undefined
            ? { sensoryNotes: merged.sensoryNotes }
            : {}),
          ...(merged.emergencyContact
            ? { emergencyContact: merged.emergencyContact }
            : {}),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();

    profileForTriage = leanToIceShape(upserted);
  }

  return profileForTriage;
}

function buildTimelineEntry(input: {
  crisisType: CrisisType;
  severityScore: number;
  gps?: { lat: number; lng: number };
  lowBandwidth: boolean;
  classificationFailed: boolean;
  now: Date;
}) {
  return {
    ts: input.now,
    crisisType: input.crisisType,
    severityScore: input.severityScore,
    gps: input.gps ?? null,
    lowBandwidth: input.lowBandwidth,
    classificationFailed: input.classificationFailed,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TriageRequest & {
      image?: string;
      audio?: string;
    };
    const {
      userId,
      gps: rawGps,
      iceProfile: phoneIce,
      simulate,
      sessionId,
    } = body;
    const imageBase64 = isNonEmptyMedia(body.imageBase64)
      ? body.imageBase64
      : body.image;
    const audioBase64 = isNonEmptyMedia(body.audioBase64)
      ? body.audioBase64
      : body.audio;

    if (!userId || typeof userId !== "string") {
      return NextResponse.json(
        { error: "Invalid request. Required: userId (string)." },
        { status: 400 },
      );
    }

    // simulate must be a perception crisis type — boolean true / garbage → 400
    if (simulate !== undefined && simulate !== null) {
      if (!isSimulateCrisisType(simulate)) {
        return NextResponse.json(
          {
            error:
              "Invalid simulate. Must be one of: ENVIRONMENTAL_HAZARD, MEDICAL_CRISIS, ACTIVE_THREAT.",
          },
          { status: 400 },
        );
      }
    }

    if (
      rawGps !== undefined &&
      rawGps !== null &&
      (typeof rawGps.lat !== "number" ||
        typeof rawGps.lng !== "number" ||
        Number.isNaN(rawGps.lat) ||
        Number.isNaN(rawGps.lng))
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid gps. When provided, gps.lat and gps.lng must be numbers.",
        },
        { status: 400 },
      );
    }

    const gps = parseOptionalGps(rawGps);
    const now = new Date();

    await connectToDatabase();

    // Session lookup BEFORE AI — RESOLVED incidents short-circuit.
    const existingSession = sessionId
      ? await ActiveIncident.findOne({ sessionId }).lean()
      : null;

    if (existingSession?.status === "RESOLVED") {
      console.log(
        "[triage] session already RESOLVED — skipping Gemini/Grok",
        sessionId,
      );
      return triageJsonResponse(serializeIncident(existingSession));
    }

    const profileForTriage = await resolveIceProfile(userId, phoneIce);
    const iceSummary = summarizeIce(profileForTriage);

    const hasMedia =
      isNonEmptyMedia(imageBase64) || isNonEmptyMedia(audioBase64);

    let crisisType: CrisisType;
    let classificationFailed = false;
    let lowBandwidth = false;
    let simulated = false;

    if (isSimulateCrisisType(simulate)) {
      // Skip Gemini; force crisis type; Grok still runs with ICE (no canned brief).
      simulated = true;
      lowBandwidth = false;
      classificationFailed = false;
      crisisType = simulate;
      console.log("[triage] simulate mode — skipping Gemini", { crisisType });
    } else if (!hasMedia) {
      crisisType = "UNKNOWN";
      lowBandwidth = true;
      classificationFailed = false;
    } else {
      lowBandwidth = false;
      const classified = await classifyWithGemini(imageBase64, audioBase64);
      crisisType = classified.crisisType;
      classificationFailed = classified.classificationFailed;

      if (!(CRISIS_TYPES as readonly string[]).includes(crisisType)) {
        crisisType = "UNKNOWN";
        classificationFailed = true;
      }

      console.log("[triage] Gemini classification", {
        crisisType,
        classificationFailed,
        rawModelText: classified.rawModelText?.slice(0, 120),
        hasImage: isNonEmptyMedia(imageBase64),
        hasAudio: isNonEmptyMedia(audioBase64),
      });
    }

    // Sticky crisis type across session ticks: don't erase a known label with UNKNOWN/fail.
    if (
      existingSession &&
      existingSession.crisisType &&
      existingSession.crisisType !== "UNKNOWN" &&
      (crisisType === "UNKNOWN" || classificationFailed)
    ) {
      console.log("[triage] keeping existing crisisType", {
        existing: existingSession.crisisType,
        incoming: crisisType,
        classificationFailed,
      });
      crisisType = existingSession.crisisType as CrisisType;
      classificationFailed = false;
    }

    const { severityScore, dispatcherBrief } = await gradeWithGrok({
      crisisType,
      lowBandwidth,
      gps,
      iceSummary,
      iceProfile: profileForTriage,
    });

    const victimInstructions = VICTIM_INSTRUCTIONS[crisisType];
    const timelineEntry = buildTimelineEntry({
      crisisType,
      severityScore,
      gps,
      lowBandwidth,
      classificationFailed,
      now,
    });

    const latestFields = {
      userId,
      crisisType,
      severityScore,
      dispatcherBrief,
      ...(gps ? { gps } : {}),
      lowBandwidth,
      classificationFailed,
      simulated,
      victimInstructions,
      iceProfile: profileForTriage,
      lastSeenAt: now,
      ...(sessionId ? { sessionId } : {}),
    };

    let incident;
    if (sessionId && existingSession) {
      // Update path: never $set status — preserves ACKNOWLEDGED / RESOLVED.
      incident = await ActiveIncident.findOneAndUpdate(
        { sessionId },
        {
          $set: latestFields,
          $inc: { updateCount: 1 },
          $push: { timeline: { $each: [timelineEntry], $slice: -50 } },
        },
        { returnDocument: "after" },
      );
    } else {
      // Create path (with or without sessionId).
      incident = await ActiveIncident.create({
        ...latestFields,
        status: "ACTIVE",
        updateCount: 1,
        timeline: [timelineEntry],
      });
    }

    if (!incident) {
      return NextResponse.json(
        { error: "Failed to persist incident" },
        { status: 500 },
      );
    }

    const lean =
      typeof incident.toObject === "function" ? incident.toObject() : incident;
    return triageJsonResponse(serializeIncident(lean));
  } catch (error) {
    console.error("[triage] unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
