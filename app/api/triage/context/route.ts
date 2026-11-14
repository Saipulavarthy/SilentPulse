import { MongoClient, type Db } from "mongodb";
import { NextResponse } from "next/server";

type ContextBody = {
  sessionId?: string;
  userContext?: string;
};

/**
 * Native Mongo client with global pooling (avoids connection storms in Next.js
 * serverless / `next dev` HMR).
 *
 * Verified against existing triage pipeline:
 * - Triage persists via Mongoose model `ActiveIncident`
 * - Default collection name: `activeincidents` (NOT `emergencies`)
 * - Database name comes from `MONGODB_URI` path (commonly `silentpulse`)
 */
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function getClientPromise(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "Missing MONGODB_URI. Set it in .env.local (MongoDB Atlas connection string).",
    );
  }

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      const client = new MongoClient(uri);
      global._mongoClientPromise = client.connect();
    }
    return global._mongoClientPromise;
  }

  const client = new MongoClient(uri);
  return client.connect();
}

function resolveDbName(uri: string): string {
  try {
    const pathname = new URL(uri).pathname.replace(/^\//, "");
    if (pathname && pathname !== "") {
      return pathname.split("?")[0] || "silentpulse";
    }
  } catch {
    // mongodb+srv URIs still parse; fall through on failure
  }
  return "silentpulse";
}

async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI!;
  const client = await getClientPromise();
  return client.db(resolveDbName(uri));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContextBody;
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const userContext =
      typeof body.userContext === "string" ? body.userContext.trim() : "";

    if (!sessionId || !userContext) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId and userContext" },
        { status: 400 },
      );
    }

    const db = await getDb();
    // Matches Mongoose ActiveIncident collection used by /api/triage
    const emergencies = db.collection("activeincidents");

    const result = await emergencies.updateOne(
      { sessionId },
      {
        $set: {
          userContext,
          // Keep schema-aligned alias used elsewhere in the app
          userProvidedContext: userContext,
          updatedAt: new Date(),
        },
      },
    );

    return NextResponse.json(
      {
        ok: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        sessionId,
        userContext,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[triage/context] update failed:", error);
    return NextResponse.json(
      { error: "Failed to update user context" },
      { status: 500 },
    );
  }
}
