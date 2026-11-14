import { MongoClient, type Db } from "mongodb";
import { NextResponse } from "next/server";

/**
 * GET /api/triage/active
 * Returns non-resolved emergency tickets for the dispatcher feed.
 *
 * Uses native Mongo client + global pooling (serverless / next dev HMR safe).
 * Collection matches Mongoose `ActiveIncident` → `activeincidents`.
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
    if (pathname) {
      return pathname.split("?")[0] || "silentpulse";
    }
  } catch {
    // fall through
  }
  return "silentpulse";
}

async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI!;
  const client = await getClientPromise();
  return client.db(resolveDbName(uri));
}

export async function GET() {
  try {
    const db = await getDb();
    const collection = db.collection("activeincidents");

    // Active tickets only — exclude resolved (and treat missing status as active)
    const emergencies = await collection
      .find({
        $or: [
          { status: { $ne: "RESOLVED" } },
          { status: { $exists: false } },
        ],
      })
      .sort({ createdAt: -1, timestamp: -1 })
      .toArray();

    return NextResponse.json(emergencies, { status: 200 });
  } catch (error) {
    console.error("[triage/active] fetch failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch active emergencies" },
      { status: 500 },
    );
  }
}
