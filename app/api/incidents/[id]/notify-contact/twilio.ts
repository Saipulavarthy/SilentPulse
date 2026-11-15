// Twilio Programmable Voice over plain fetch (no SDK), plus the notify-contact env.
// Auth: HTTP Basic. With TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET both set, those are the
// username and password; otherwise TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. The Account SID is
// always in the request path. Never log or return any of these values.
// Docs: https://www.twilio.com/docs/voice/api/call-resource, https://www.twilio.com/docs/iam/api-keys

import { parseAllowlist } from '@/lib/contactCall';
import { CONTACT_CALL_STATUSES, type ContactCallStatus } from '@/types/contactCall';

const API = 'https://api.twilio.com/2010-04-01';
const TIMEOUT_MS = 15_000;

type TwilioConfig = { accountSid: string; username: string; password: string; from: string };

/**
 * Null (→ 503 "calling not configured") unless the account SID, the from number and one
 * credential pair are set: the API key pair if both halves are present, else the auth token.
 */
export function twilioConfig(): TwilioConfig | null {
  const env = (k: string) => process.env[k]?.trim() || undefined;
  const accountSid = env('TWILIO_ACCOUNT_SID');
  const from = env('TWILIO_FROM_NUMBER');
  const keySid = env('TWILIO_API_KEY_SID');
  const keySecret = env('TWILIO_API_KEY_SECRET');
  const authToken = env('TWILIO_AUTH_TOKEN');
  if (!accountSid || !from) return null;
  if (keySid && keySecret) return { accountSid, username: keySid, password: keySecret, from };
  if (authToken) return { accountSid, username: accountSid, password: authToken, from };
  return null;
}

/**
 * TWILIO_VOICE_MODE: "template" (default) or "twiml".
 * - template: trial accounts. The call uses Twilio's text-to-speech voice template URL from the
 *   trial "Try out Voice" docs; Twilio documents no way to pass custom text to it, so the contact
 *   hears Twilio's own trial message, not our script.
 * - twiml: upgraded accounts. Our reviewed script, inline, spoken twice.
 */
export type VoiceMode = 'template' | 'twiml';
export const voiceMode = (): VoiceMode => (process.env.TWILIO_VOICE_MODE?.trim().toLowerCase() === 'twiml' ? 'twiml' : 'template');
/** https://www.twilio.com/docs/usage/trials/try-out-voice ("sample call instructions"). */
export const TRIAL_TEMPLATE_URL = 'https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech';

export const demoMode = () => /^(1|true|yes|on)$/i.test(process.env.NOTIFY_DEMO_MODE?.trim() ?? '');
export const allowlist = () => parseAllowlist(process.env.NOTIFY_ALLOWLIST);

const auth = (c: TwilioConfig) => `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
const callsUrl = (c: TwilioConfig) => `${API}/Accounts/${encodeURIComponent(c.accountSid)}/Calls`;

export class TwilioError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Twilio error text can quote phone numbers or SIDs; keep neither. */
const scrub = (s: string) =>
  s
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\b(AC|SK|CA|PN)[0-9a-f]{32}\b/gi, '[id]')
    .slice(0, 200);

async function request(c: TwilioConfig, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: auth(c), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new TwilioError(504, null, name === 'TimeoutError' ? 'Twilio did not answer in time.' : 'Could not reach Twilio.');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const code = typeof body?.code === 'number' ? body.code : null;
    const message = typeof body?.message === 'string' ? scrub(body.message) : `HTTP ${res.status}`;
    throw new TwilioError(res.status, code, message);
  }
  return body;
}

const asStatus = (v: unknown): ContactCallStatus =>
  (CONTACT_CALL_STATUSES as readonly string[]).includes(v as string) ? (v as ContactCallStatus) : 'queued';

/** Places an outbound call: inline TwiML, or a template Url (no status webhooks either way). */
export async function createCall(
  c: TwilioConfig,
  to: string,
  how: { twiml: string } | { url: string },
): Promise<{ sid: string; status: ContactCallStatus }> {
  const params = new URLSearchParams({ To: to, From: c.from, ...('twiml' in how ? { Twiml: how.twiml } : { Url: how.url }) });
  const body = await request(c, `${callsUrl(c)}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (typeof body.sid !== 'string') throw new TwilioError(502, null, 'Twilio response had no call SID.');
  return { sid: body.sid, status: asStatus(body.status) };
}

/** Current status of a call; answeredAt when it can be worked out (end time minus duration). */
export async function fetchCall(c: TwilioConfig, sid: string): Promise<{ status: ContactCallStatus; answeredAt: Date | null }> {
  const body = await request(c, `${callsUrl(c)}/${encodeURIComponent(sid)}.json`, { method: 'GET' });
  const status = asStatus(body.status);
  const end = typeof body.end_time === 'string' ? Date.parse(body.end_time) : NaN;
  const duration = Number(body.duration);
  const answeredAt = status === 'completed' && Number.isFinite(end) && Number.isFinite(duration) && duration > 0 ? new Date(end - duration * 1000) : null;
  return { status, answeredAt };
}
