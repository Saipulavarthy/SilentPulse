import { connection, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { IceProfile } from "@/models/IceProfile";
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

    const incidents = await ActiveIncident.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const userIds = [...new Set(incidents.map((incident) => incident.userId))];
    const profiles = await IceProfile.find({
      userId: { $in: userIds },
    }).lean();

    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );

    const enriched = incidents.map((incident) => ({
      ...incident,
      iceProfile: profileByUserId.get(incident.userId) ?? null,
    }));

    return NextResponse.json({ incidents: enriched }, { status: 200 });
  } catch (error) {
    console.error("[incidents] GET unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
