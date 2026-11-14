import { NextResponse } from "next/server";

type TriageRequestBody = {
  userId?: string;
  gps?: {
    lat?: number;
    lng?: number;
  };
  imageBase64?: string;
  audioBase64?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TriageRequestBody;
    const { userId, gps } = body;

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

    // Simulate dual-AI inference latency for frontend wiring.
    await new Promise((res) => setTimeout(res, 2000));

    return NextResponse.json(
      {
        incidentId: "mock_incident_001",
        crisisType: "ENVIRONMENTAL_HAZARD",
        severityScore: 8,
        dispatcherBrief:
          "Simulated environmental hazard detected near reported coordinates. Emergency units advised to approach with caution.",
        isLowBandwidth: false,
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
