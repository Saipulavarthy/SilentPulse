import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { IceProfile } from "@/models/IceProfile";

export async function POST(request: Request) {
  try {
    const expected = process.env.SILENTPULSE_SEED_KEY;
    const provided = request.headers.get("x-silentpulse-key");

    if (!expected || provided !== expected) {
      return NextResponse.json(
        { error: "Unauthorized. Provide a valid x-silentpulse-key header." },
        { status: 401 },
      );
    }

    await connectToDatabase();

    const profile = await IceProfile.findOneAndUpdate(
      { userId: "user_demo_01" },
      {
        $set: {
          userId: "user_demo_01",
          name: "Jordan Rivera",
          age: 20,
          bloodType: "O-",
          allergies: ["Penicillin", "Severe Peanut Allergy"],
          conditions: ["Asthma", "Type 1 Diabetes"],
          medications: ["Albuterol Inhaler", "Insulin"],
          emergencyContact: {
            name: "Maya Patel",
            phone: "+1-555-0142",
            relation: "Spouse",
          },
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    return NextResponse.json(profile, { status: 200 });
  } catch (error) {
    console.error("[seed] unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
