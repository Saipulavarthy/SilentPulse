import { connection, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { ActiveIncident } from "@/models/Incident";
import {
  statusToDispatcherStatus,
  type IncidentStatus,
} from "@/types/incident";

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * Lightweight phone poll for a single SOS session.
 * Returns only status / dispatcherStatus / dispatcherMessage (+ _id for seen reports).
 * Uses connection() so Cache Components never prerender/cache this read.
 */
export async function GET(request: Request) {
  // Must stay outside try/catch so Cache Components prerender can bail cleanly.
  await connection();

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId")?.trim() ?? "";

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing sessionId" },
        { status: 400 },
      );
    }

    await connectToDatabase();

    const doc = await ActiveIncident.findOne({ sessionId })
      .select({ status: 1, dispatcherMessage: 1 })
      .lean();

    if (!doc) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 },
      );
    }

    const status = doc.status as IncidentStatus;
    const raw = doc.dispatcherMessage as
      | { text?: string; sentAt?: Date | string; seenAt?: Date | string }
      | null
      | undefined;

    const dispatcherMessage =
      raw?.text && raw.sentAt
        ? {
            text: raw.text,
            sentAt: toIso(raw.sentAt),
            ...(raw.seenAt ? { seenAt: toIso(raw.seenAt) } : {}),
          }
        : undefined;

    return NextResponse.json(
      {
        _id: typeof doc._id === "string" ? doc._id : doc._id.toString(),
        status,
        dispatcherStatus: statusToDispatcherStatus(status),
        ...(dispatcherMessage ? { dispatcherMessage } : {}),
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("[incidents/session] GET unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
