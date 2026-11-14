import { connection, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { serializeIncident } from "@/lib/serializeIncident";
import {
  ActiveIncident,
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "@/models/Incident";

/** Phone ticks ~30s; triage can take ~30s — default 75s avoids false alarms. */
const SIGNAL_LOSS_MS = Number(process.env.SIGNAL_LOSS_MS ?? 75_000);

export async function GET(request: Request) {
  // Must stay outside try/catch so Cache Components prerender can bail cleanly.
  await connection();

  try {
    await connectToDatabase();

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");

    const filter: { status?: IncidentStatus } = {};
    if (statusParam) {
      if (!(INCIDENT_STATUSES as readonly string[]).includes(statusParam)) {
        return NextResponse.json(
          {
            error: `Invalid status. Must be one of: ${INCIDENT_STATUSES.join(", ")}`,
          },
          { status: 400 },
        );
      }
      filter.status = statusParam as IncidentStatus;
    }

    // Escalate live sessions that went silent before returning the list.
    const cutoff = new Date(Date.now() - SIGNAL_LOSS_MS);
    const escalated = await ActiveIncident.updateMany(
      {
        status: "ACTIVE",
        sessionId: { $exists: true, $nin: [null, ""] },
        lastSeenAt: { $exists: true, $lt: cutoff },
        escalated: { $ne: true },
      },
      {
        $set: {
          escalated: true,
          severityScore: 10,
          escalationReason: "Signal lost: no update for 75s",
        },
        $push: {
          reasons: "Signal lost after live tracking began",
        },
      },
    );
    if (escalated.modifiedCount > 0) {
      console.log(
        `[incidents] escalated ${escalated.modifiedCount} silent session(s)`,
        { SIGNAL_LOSS_MS, cutoff: cutoff.toISOString() },
      );
    }

    // Escalated first, then severity, then newest.
    const incidents = await ActiveIncident.find(filter)
      .sort({ escalated: -1, severityScore: -1, createdAt: -1 })
      .limit(50)
      .lean();

    return NextResponse.json(
      { incidents: incidents.map((doc) => serializeIncident(doc)) },
      { status: 200 },
    );
  } catch (error) {
    console.error("[incidents] GET unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
