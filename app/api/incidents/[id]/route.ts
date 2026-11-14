import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { serializeIncident } from "@/lib/serializeIncident";
import {
  ActiveIncident,
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "@/models/Incident";

type PatchBody = {
  status?: string;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { error: "Invalid incident id" },
        { status: 400 },
      );
    }

    const body = (await request.json()) as PatchBody;
    const { status } = body;

    if (
      !status ||
      !(INCIDENT_STATUSES as readonly string[]).includes(status)
    ) {
      return NextResponse.json(
        {
          error: `Invalid status. Must be one of: ${INCIDENT_STATUSES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    await connectToDatabase();

    const updated = await ActiveIncident.findByIdAndUpdate(
      id,
      { status: status as IncidentStatus },
      { new: true },
    ).lean();

    if (!updated) {
      return NextResponse.json(
        { error: "Incident not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(serializeIncident(updated), { status: 200 });
  } catch (error) {
    console.error("[incidents] PATCH unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
