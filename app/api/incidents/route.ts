import { connection, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { serializeIncident } from "@/lib/serializeIncident";
import {
  ActiveIncident,
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "@/models/Incident";

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

    // Use the ICE snapshot stored on each incident — no live IceProfile join.
    const incidents = await ActiveIncident.find(filter)
      .sort({ createdAt: -1 })
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
