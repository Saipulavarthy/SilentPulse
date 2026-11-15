import { NextResponse } from "next/server";
import { classifyWithGemini } from "@/lib/ai/gemini";
import { gradeWithGrok, type GrokHistoryEntry } from "@/lib/ai/grok";
import { isNonEmptyMedia } from "@/lib/ai/media";
import { buildingAt } from "@/lib/buildingLookup";
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
  Building,
  IceProfile as IceProfileShape,
  SimulateCrisisType,
  TriageRequest,
} from "@/types/incident";

/** Vercel / Next route segment: allow full Gemini+Grok budget. */
export const maxDuration = 60;

const PERCEPTION_TYPES = [
  "ENVIRONMENTAL_HAZARD",
  "MEDICAL_CRISIS",
  "ACTIVE_THREAT",
] as const;

function isSimulateCrisisType(value: unknown): value is SimulateCrisisType {
  return (
    typeof value === "string" &&
    (PERCEPTION_TYPES as readonly string[]).includes(value)
  );
}

function parseOptionalGps(gps: TriageRequest["gps"]):
  | {
      lat: number;
      lng: number;
      accuracy?: number;
      altitude?: number;
    }
  | undefined {
  if (
    typeof gps?.lat !== "number" ||
    typeof gps?.lng !== "number" ||
    Number.isNaN(gps.lat) ||
    Number.isNaN(gps.lng)
  ) {
    return undefined;
  }
  return {
    lat: gps.lat,
    lng: gps.lng,
    ...(typeof gps.accuracy === "number" &&
    Number.isFinite(gps.accuracy) &&
    gps.accuracy >= 0
      ? { accuracy: gps.accuracy }
      : {}),
    ...(typeof gps.altitude === "number" && Number.isFinite(gps.altitude)
      ? { altitude: gps.altitude }
      : {}),
  };
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
      sceneSummary: serialized.sceneSummary,
      cues: serialized.cues ?? [],
      reasons: serialized.reasons ?? [],
      trend: serialized.trend ?? "new",
      building: serialized.building ?? null,
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
  sceneSummary?: string;
  now: Date;
}) {
  return {
    ts: input.now,
    crisisType: input.crisisType,
    severityScore: input.severityScore,
    gps: input.gps ?? null,
    lowBandwidth: input.lowBandwidth,
    classificationFailed: input.classificationFailed,
    ...(input.sceneSummary ? { sceneSummary: input.sceneSummary } : {}),
  };
}

function historyFromSession(
  existing: {
    severityScore?: number;
    timeline?: Array<{
      ts?: Date | string;
      crisisType?: string;
      severityScore?: number;
      sceneSummary?: string | null;
    }> | null;
  } | null,
): { history: GrokHistoryEntry[]; previousSeverityScore?: number } {
  if (!existing) return { history: [] };
  const entries = Array.isArray(existing.timeline) ? existing.timeline : [];
  const last3 = entries.slice(-3).map((e) => ({
    ts:
      e.ts instanceof Date
        ? e.ts.toISOString()
        : typeof e.ts === "string"
          ? e.ts
          : new Date().toISOString(),
    crisisType: String(e.crisisType ?? "UNKNOWN"),
    severityScore:
      typeof e.severityScore === "number" ? e.severityScore : 8,
    ...(e.sceneSummary ? { sceneSummary: e.sceneSummary } : {}),
  }));
  return {
    history: last3,
    previousSeverityScore:
      typeof existing.severityScore === "number"
        ? existing.severityScore
        : undefined,
  };
}

export async function POST(request: Request) {
  const triageStarted = Date.now();
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
    let sceneSummary: string | undefined;
    let cues: string[] = [];

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
      sceneSummary = classified.sceneSummary;
      cues = classified.cues ?? [];

      if (!(CRISIS_TYPES as readonly string[]).includes(crisisType)) {
        crisisType = "UNKNOWN";
        classificationFailed = true;
      }

      console.log("[triage] Gemini classification", {
        crisisType,
        classificationFailed,
        sceneSummary,
        cues,
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
      if (!sceneSummary && existingSession.sceneSummary) {
        sceneSummary = existingSession.sceneSummary;
      }
      if (cues.length === 0 && Array.isArray(existingSession.cues)) {
        cues = existingSession.cues as string[];
      }
    }

    const { history, previousSeverityScore } =
      historyFromSession(existingSession);

    // Resolve building from this tick's GPS. If this tick omitted GPS, keep the
    // prior session building so a missed fix does not wipe a known location.
    let building: Building | null = gps
      ? buildingAt(gps.lat, gps.lng)
      : null;
    if (
      !gps &&
      !building &&
      existingSession?.building &&
      typeof existingSession.building === "object" &&
      typeof (existingSession.building as Building).name === "string"
    ) {
      const prev = existingSession.building as Building;
      building = {
        name: prev.name,
        type: prev.type,
        floors: prev.floors,
        ...(prev.notes ? { notes: prev.notes } : {}),
      };
      console.log("[triage] keeping prior building (no gps on this tick)", {
        name: building.name,
      });
    }

    const {
      severityScore,
      dispatcherBrief,
      trend,
      reasons,
      victimInstructions,
    } = await gradeWithGrok({
      crisisType,
      lowBandwidth,
      gps,
      iceSummary,
      iceProfile: profileForTriage,
      sceneSummary,
      cues,
      simulated,
      building,
      history,
      previousSeverityScore,
    });

    const timelineEntry = buildTimelineEntry({
      crisisType,
      severityScore,
      gps,
      lowBandwidth,
      classificationFailed,
      sceneSummary,
      now,
    });

    const wasEscalated = Boolean(existingSession?.escalated);
    const reasonsToStore = wasEscalated
      ? [...reasons, "Signal restored"]
      : reasons;

    const latestFields = {
      userId,
      crisisType,
      severityScore,
      dispatcherBrief,
      ...(sceneSummary ? { sceneSummary } : {}),
      cues,
      reasons: reasonsToStore,
      trend,
      ...(gps ? { gps } : {}),
      building,
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
      // Clear signal-loss escalation; Grok severity replaces the forced 10.
      incident = await ActiveIncident.findOneAndUpdate(
        { sessionId },
        {
          $set: {
            ...latestFields,
            escalated: false,
          },
          $unset: { escalationReason: "" },
          $inc: { updateCount: 1 },
          $push: { timeline: { $each: [timelineEntry], $slice: -50 } },
        },
        { returnDocument: "after" },
      );
    } else {
      // Create path (with or without sessionId).
      incident = await ActiveIncident.create({
        ...latestFields,
        escalated: false,
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

    console.log(
      `[triage] total latency ${Date.now() - triageStarted}ms`,
      { crisisType, trend, cues: cues.length, reasons: reasons.length },
    );

    const lean =
      typeof incident.toObject === "function" ? incident.toObject() : incident;
    return triageJsonResponse(serializeIncident(lean));
  } catch (error) {
    console.error("[triage] unexpected error:", error);
    console.log(
      `[triage] total latency ${Date.now() - triageStarted}ms (error)`,
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
