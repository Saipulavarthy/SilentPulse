import type { IceProfile, PhoneIceProfilePayload } from "@/types/incident";

const MAX_LEN = 300;

function cap(value: string): string {
  return value.length <= MAX_LEN ? value : value.slice(0, MAX_LEN);
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? cap(trimmed) : undefined;
}

function splitList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => cap(part));
}

function parseAge(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0 || n > 120) return undefined;
  return Math.trunc(n);
}

/**
 * Normalize the phone's localStorage ICE form into our Mongo/Grok IceProfile shape.
 * Returns null when the phone sends `{}` / empty (nothing useful saved).
 */
export function iceFromPhone(
  payload: PhoneIceProfilePayload | undefined,
): IceProfile | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }

  const name = asTrimmedString(payload.fullName);
  const age = parseAge(payload.age);
  const bloodType = asTrimmedString(payload.bloodType);
  const conditions = splitList(payload.medicalConditions);
  const allergies = splitList(payload.allergies);
  const mobilityNotes = asTrimmedString(payload.mobilityNotes);
  const sensoryNotes = asTrimmedString(payload.sensoryNotes);

  const contactName = asTrimmedString(payload.emergencyContactName);
  const contactPhone = asTrimmedString(payload.emergencyContactPhone);
  const emergencyContact =
    contactName || contactPhone
      ? {
          ...(contactName ? { name: contactName } : {}),
          ...(contactPhone ? { phone: contactPhone } : {}),
        }
      : undefined;

  if (!name && conditions.length === 0 && allergies.length === 0) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(age !== undefined ? { age } : {}),
    ...(bloodType ? { bloodType } : {}),
    conditions,
    allergies,
    ...(mobilityNotes ? { mobilityNotes } : {}),
    ...(sensoryNotes ? { sensoryNotes } : {}),
    ...(emergencyContact ? { emergencyContact } : {}),
  };
}
