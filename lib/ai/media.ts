/** Shared media helpers for Gemini multimodal parts. */

export function isNonEmptyMedia(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Accepts data URIs with optional charset / extra params before ;base64, */
export function parseDataUri(input: string): { mimeType: string; data: string } {
  const trimmed = input.trim();
  const match =
    /^data:([^;,]+)(?:;charset=[^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(
      trimmed,
    );
  if (match) {
    return {
      mimeType: match[1],
      data: match[2].replace(/\s/g, ""),
    };
  }
  return {
    mimeType: "application/octet-stream",
    data: trimmed.replace(/\s/g, ""),
  };
}

/**
 * Preserve real audio/video MIME types from the phone.
 * Never force image/jpeg onto webm/mp4 — Gemini 400s on that mismatch.
 */
export function resolveMediaMime(
  parsedMime: string,
  slot: "visual" | "audio",
): string {
  const mt = (parsedMime || "").toLowerCase().trim();
  if (mt.startsWith("audio/")) return mt;
  if (mt.startsWith("video/")) return mt;
  if (mt.startsWith("image/") && slot === "visual") return mt;

  if (slot === "audio") {
    if (mt.includes("webm")) return "audio/webm";
    if (mt.includes("ogg")) return "audio/ogg";
    if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) {
      return "audio/mp4";
    }
    if (mt.includes("mpeg") || mt.includes("mp3")) return "audio/mpeg";
    if (mt.includes("wav")) return "audio/wav";
    return "audio/webm";
  }

  if (mt.includes("webm")) return "video/webm";
  if (mt.includes("mp4")) return "video/mp4";
  if (mt.includes("png")) return "image/png";
  if (mt.includes("webp")) return "image/webp";
  if (mt.includes("gif")) return "image/gif";
  return "image/jpeg";
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
