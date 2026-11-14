import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { ActiveIncident } from "@/models/Incident";

type ContextBody = {
  sessionId?: string;
  userContext?: string;
};

/**
 * Victim quick-action context from the phone UI.
 * Attaches a human-selected label to the active incident for dispatchers.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContextBody;
    const sessionId = body.sessionId?.trim();
    const userContext = body.userContext?.trim();

    if (!sessionId || !userContext) {
      return NextResponse.json(
        { error: "sessionId and userContext are required" },
        { status: 400 },
      );
    }

    await connectToDatabase();

    const incident = await ActiveIncident.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          userProvidedContext: userContext,
          updatedAt: new Date(),
        },
      },
      { new: true },
    ).lean();

    if (!incident) {
      // Soft-success for demo: context still logged even if incident row is missing
      console.warn("[triage/context] no incident for sessionId:", sessionId, userContext);
      return NextResponse.json(
        { ok: true, saved: false, sessionId, userContext },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        saved: true,
        sessionId,
        userContext,
        incidentId: String(incident._id),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[triage/context] unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
