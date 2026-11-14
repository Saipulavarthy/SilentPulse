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
import type { IceProfile as IceProfileShape, TriageRequest } from "@/types/incident";
import { VICTIM_INSTRUCTIONS } from "@/types/incident";

type GrokTriageResult = {
  severityScore: number;
  dispatcherBrief: string;
};

type ClassifyResult = {
  crisisType: CrisisType;
  classificationFailed: boolean;
  rawModelText?: string;
};

/** Multimodal classify needs headroom (image + 3s audio). */
const AI_TIMEOUT_MS = 25_000;

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
  "Do not default to ACTIVE_THREAT. If evidence is ambiguous between medical and threat, prefer MEDICAL_CRISIS.",
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
  return { mimeType: "application/octet-stream", data: trimmed.replace(/\s/g, "") };
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

  // visual slot: still/canvas frame defaults to jpeg; video blobs stay video/*
  if (mt.includes("webm")) return "video/webm";
  if (mt.includes("mp4")) return "video/mp4";
  if (mt.includes("png")) return "image/png";
  if (mt.includes("webp")) return "image/webp";
  if (mt.includes("gif")) return "image/gif";
  return "image/jpeg";
}

function extractCrisisType(raw: string): PerceptionCrisisType | null {
  const upper = raw.toUpperCase();
  // Prefer an explicit label embedded anywhere in the model reply.
  const embedded = upper.match(
    /\b(ENVIRONMENTAL_HAZARD|MEDICAL_CRISIS|ACTIVE_THREAT)\b/,
  );
  if (embedded) return embedded[1] as PerceptionCrisisType;

  let normalized = upper.trim().replace(/[^A-Z_]/g, "");
  // Common Gemini inventions / aliases
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

async function classifyWithGemini(
  imageBase64: string | undefined,
  audioBase64: string | undefined,
): Promise<ClassifyResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[triage] GEMINI_API_KEY missing; classificationFailed");
    // Do NOT bias to ACTIVE_THREAT on failure — that made every SOS look like a threat.
    return { crisisType: "UNKNOWN", classificationFailed: true };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: GEMINI_SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 32,
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
        // Strip codec params from mime for Gemini (audio/webm;codecs=opus → audio/webm)
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

    // Debug Gemini 400s: empty payloads vs oversized inline base64.
    console.log("Gemini Parts:", JSON.stringify(parts).substring(0, 500));
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
      AI_TIMEOUT_MS,
      "Gemini",
    );
    const text = result.response.text() ?? "";
    console.log("[triage] Gemini raw classification:", text);
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
      AI_TIMEOUT_MS,
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
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    profileForTriage = leanToIceShape(upserted);
  }

  return profileForTriage;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TriageRequest & {
      image?: string;
      audio?: string;
    };
    // Prefer imageBase64/audioBase64; fall back to phone's `image`/`audio` aliases.
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

    // GPS is optional; if present, both lat/lng must be valid numbers.
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

    await connectToDatabase();
    const profileForTriage = await resolveIceProfile(userId, phoneIce);
    const iceSummary = summarizeIce(profileForTriage);

    const hasMedia =
      isNonEmptyMedia(imageBase64) || isNonEmptyMedia(audioBase64);
    const lowBandwidth = !hasMedia;

    let crisisType: CrisisType;
    let classificationFailed = false;
    let severityScore: number;
    let dispatcherBrief: string;

    if (simulate) {
      crisisType = lowBandwidth ? "UNKNOWN" : "ENVIRONMENTAL_HAZARD";
      severityScore = 8;
      dispatcherBrief = lowBandwidth
        ? `Simulated low-bandwidth SOS${gps ? ` at ${gps.lat}, ${gps.lng}` : ""}. Emergency units advised; AI path skipped (simulate=true).`
        : `Simulated environmental hazard${gps ? ` near ${gps.lat}, ${gps.lng}` : ""}. Emergency units advised to approach with caution (simulate=true).`;
    } else if (lowBandwidth) {
      crisisType = "UNKNOWN";
      const graded = await gradeWithGrok({
        crisisType,
        lowBandwidth,
        gps,
        iceSummary,
        iceProfile: profileForTriage,
      });
      severityScore = graded.severityScore;
      dispatcherBrief = graded.dispatcherBrief;
    } else {
      const classified = await classifyWithGemini(imageBase64, audioBase64);
      crisisType = classified.crisisType;
      classificationFailed = classified.classificationFailed;

      if (!(CRISIS_TYPES as readonly string[]).includes(crisisType)) {
        // Failed/unparseable classify → UNKNOWN, never force ACTIVE_THREAT.
        crisisType = "UNKNOWN";
        classificationFailed = true;
      }

      console.log("[triage] final classification", {
        crisisType,
        classificationFailed,
        rawModelText: classified.rawModelText?.slice(0, 120),
        hasImage: isNonEmptyMedia(imageBase64),
        hasAudio: isNonEmptyMedia(audioBase64),
      });

      const graded = await gradeWithGrok({
        crisisType,
        lowBandwidth,
        gps,
        iceSummary,
        iceProfile: profileForTriage,
      });
      severityScore = graded.severityScore;
      dispatcherBrief = graded.dispatcherBrief;
    }

    const victimInstructions = VICTIM_INSTRUCTIONS[crisisType];

    const triageFields = {
      userId,
      crisisType,
      severityScore,
      dispatcherBrief,
      ...(gps ? { gps } : {}),
      lowBandwidth,
      classificationFailed,
      victimInstructions,
      iceProfile: profileForTriage,
      ...(sessionId ? { sessionId } : {}),
    };

    // Continuous telemetry: upsert by sessionId so later polls see Kiran's status.
    // Do NOT $set status on update — preserves ACKNOWLEDGED after "Send Help".
    const incident = sessionId
      ? await ActiveIncident.findOneAndUpdate(
          { sessionId },
          {
            $set: triageFields,
            $setOnInsert: { status: "ACTIVE" },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
      : await ActiveIncident.create({
          ...triageFields,
          status: "ACTIVE",
        });

    if (!incident) {
      return NextResponse.json(
        { error: "Failed to persist incident" },
        { status: 500 },
      );
    }

    const lean =
      typeof incident.toObject === "function" ? incident.toObject() : incident;
    const serialized = serializeIncident(lean);

    return NextResponse.json(
      {
        incidentId: serialized._id,
        sessionId: serialized.sessionId,
        // Friend's frontend contract aliases:
        classification: serialized.crisisType,
        dispatcherStatus: serialized.dispatcherStatus,
        crisisType: serialized.crisisType,
        severityScore: serialized.severityScore,
        dispatcherBrief: serialized.dispatcherBrief,
        lowBandwidth: serialized.lowBandwidth,
        classificationFailed: serialized.classificationFailed,
        victimInstructions: serialized.victimInstructions,
        iceProfile: serialized.iceProfile,
        incident: serialized,
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
