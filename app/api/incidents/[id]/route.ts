import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { serializeIncident } from "@/lib/serializeIncident";
import {
  ActiveIncident,
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "@/models/Incident";

const DISPATCHER_MESSAGE_MAX = 140;

type PatchBody = {
  status?: string;
  /** Plain text to show on the caller's phone; empty string clears. */
  dispatcherMessage?: string;
  /** Phone reports that the current message was displayed. */
  dispatcherMessageSeen?: boolean;
};

function validateDispatcherMessageText(
  value: unknown,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "dispatcherMessage must be a string" };
  }
  // Reject control characters (keep newline/tab out — plain single-line text).
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) {
    return { ok: false, error: "dispatcherMessage must be plain text" };
  }
  const text = value.trim();
  if (text.length === 0) {
    return { ok: true, text: "" };
  }
  if (text.length > DISPATCHER_MESSAGE_MAX) {
    return {
      ok: false,
      error: `dispatcherMessage must be at most ${DISPATCHER_MESSAGE_MAX} characters`,
    };
  }
  return { ok: true, text };
}

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
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const hasMessage = Object.prototype.hasOwnProperty.call(
      body,
      "dispatcherMessage",
    );
    const hasSeen = body.dispatcherMessageSeen === true;

    if (!hasStatus && !hasMessage && !hasSeen) {
      return NextResponse.json(
        {
          error:
            "Provide status, dispatcherMessage, and/or dispatcherMessageSeen",
        },
        { status: 400 },
      );
    }

    // Status-only requests: same validation and update as before.
    if (hasStatus) {
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
    }

    let messageText: string | undefined;
    if (hasMessage) {
      const validated = validateDispatcherMessageText(body.dispatcherMessage);
      if (!validated.ok) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      messageText = validated.text;
    }

    await connectToDatabase();

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};

    if (hasStatus) {
      $set.status = body.status as IncidentStatus;
    }

    if (hasMessage) {
      if (messageText === "") {
        $unset.dispatcherMessage = "";
      } else {
        $set.dispatcherMessage = {
          text: messageText,
          sentAt: new Date(),
        };
        // Clearing seenAt when replacing: omit seenAt on the new subdoc.
      }
    }

    if (hasSeen) {
      // Only stamp seenAt when a message exists and has not been seen yet.
      const current = await ActiveIncident.findById(id)
        .select("dispatcherMessage")
        .lean();
      if (!current) {
        return NextResponse.json(
          { error: "Incident not found" },
          { status: 404 },
        );
      }
      const msg = current.dispatcherMessage as
        | { text?: string; sentAt?: Date; seenAt?: Date }
        | null
        | undefined;
      if (msg?.text && msg.sentAt && !msg.seenAt) {
        $set["dispatcherMessage.seenAt"] = new Date();
      }
    }

    // If we're setting a whole new dispatcherMessage object and also seen in
    // the same request, prefer the fresh message without seenAt.
    if (hasMessage && messageText !== "" && hasSeen) {
      delete $set["dispatcherMessage.seenAt"];
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    if (Object.keys(update).length === 0) {
      // Seen was a no-op (already seen / no message) — return current doc.
      const existing = await ActiveIncident.findById(id).lean();
      if (!existing) {
        return NextResponse.json(
          { error: "Incident not found" },
          { status: 404 },
        );
      }
      return NextResponse.json(serializeIncident(existing), { status: 200 });
    }

    const updated = await ActiveIncident.findByIdAndUpdate(id, update, {
      returnDocument: "after",
    }).lean();

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
