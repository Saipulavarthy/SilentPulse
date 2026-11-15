// GET  /api/incidents/:id/notify-contact: availability + call log (latest call refreshed from Twilio).
// POST /api/incidents/:id/notify-contact: places a call to the caller's emergency contact.
//
// Every safety rule is enforced here, whatever the dashboard shows: allowlist only, severity ≥ 7
// and not resolved (alert), one call per kind unless forced, re-validated script, demo preamble.

import mongoose from 'mongoose';
import { connection } from 'next/server';
import {
  TWIML_MAX_CHARS,
  buildTwiml,
  contactPhone,
  duplicateReason,
  ineligibleReason,
  lastFour,
  latestCall,
  normalizePhone,
  scriptCheckFor,
  scriptFacts,
  spokenText,
  validateScript,
  CONTACT_MIN_SEVERITY,
  DEMO_PREAMBLE,
} from '@/lib/contactCall';
import { connectToDatabase } from '@/lib/mongodb';
import { serializeIncident } from '@/lib/serializeIncident';
import { ActiveIncident } from '@/models/Incident';
import {
  CONTACT_CALL_ACTIVE,
  type ContactCall,
  type ContactCallError,
  type ContactCallErrorCode,
  type ContactCallKind,
  type ContactCallStateResponse,
  type PlaceContactCallResponse,
} from '@/types/contactCall';
import { TRIAL_TEMPLATE_URL, TwilioError, allowlist, createCall, demoMode, fetchCall, twilioConfig, voiceMode } from './twilio';

/** Twilio is called with a 15 s timeout. */
export const maxDuration = 20;

const STATUS: Record<ContactCallErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  not_configured: 503,
  not_allowed: 403,
  not_eligible: 409,
  already_called: 409,
  invalid_script: 422,
  upstream: 502,
};

const json = (body: PlaceContactCallResponse | ContactCallStateResponse) =>
  Response.json(body, { status: body.ok ? 200 : STATUS[body.error], headers: { 'Cache-Control': 'no-store' } });
const fail = (error: ContactCallErrorCode, message: string, problems?: string[]) =>
  json({ ok: false, error, message, ...(problems ? { problems } : {}) } satisfies ContactCallError);

const isKind = (v: unknown): v is ContactCallKind => v === 'alert' || v === 'allClear';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Must stay outside try/catch so Cache Components prerender can bail cleanly.
  await connection();
  try {
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) return fail('bad_request', 'Invalid incident id');
    await connectToDatabase();
    const doc = await ActiveIncident.findById(id).lean();
    if (!doc) return fail('not_found', 'Incident not found');
    const incident = serializeIncident(doc);
    const config = twilioConfig();
    const phone = normalizePhone(contactPhone(incident));
    let calls = incident.contactCalls ?? [];

    // Refresh the latest call while it is still in progress.
    const latest = latestCall(calls);
    if (config && latest?.callSid && CONTACT_CALL_ACTIVE.includes(latest.status)) {
      try {
        const fresh = await fetchCall(config, latest.callSid);
        const now = new Date();
        const answeredAt =
          latest.answeredAt ?? (fresh.answeredAt?.toISOString() || (fresh.status === 'in-progress' ? now.toISOString() : undefined));
        if (fresh.status !== latest.status || answeredAt !== latest.answeredAt) {
          await ActiveIncident.updateOne(
            { _id: id },
            {
              $set: {
                'contactCalls.$[c].status': fresh.status,
                'contactCalls.$[c].updatedAt': now,
                ...(answeredAt ? { 'contactCalls.$[c].answeredAt': new Date(answeredAt) } : {}),
              },
            },
            { arrayFilters: [{ 'c.callSid': latest.callSid }] },
          );
          calls = calls.map((c) =>
            c.callSid === latest.callSid
              ? { ...c, status: fresh.status, updatedAt: now.toISOString(), ...(answeredAt ? { answeredAt } : {}) }
              : c,
          );
        }
      } catch (err) {
        console.error('[notify-contact] status refresh failed', err instanceof TwilioError ? { http: err.httpStatus, code: err.code } : 'network');
      }
    }

    return json({
      ok: true,
      configured: config !== null,
      allowlisted: phone !== null && allowlist().has(phone),
      customScript: voiceMode() === 'twiml',
      calls,
    });
  } catch (error) {
    console.error('[notify-contact] GET unexpected error:', (error as Error)?.message);
    return fail('upstream', 'Internal server error');
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) return fail('bad_request', 'Invalid incident id');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const kind = body?.kind;
    const script = typeof body?.script === 'string' ? body.script.replace(/\s+/g, ' ').trim() : '';
    const force = body?.force === true;
    const building = typeof body?.building === 'string' ? body.building : null;
    if (!isKind(kind) || !script) return fail('bad_request', 'Body must be { kind: "alert" | "allClear", script, force? }.');

    const config = twilioConfig();
    if (!config) return fail('not_configured', 'calling not configured');

    await connectToDatabase();
    const doc = await ActiveIncident.findById(id).lean();
    if (!doc) return fail('not_found', 'Incident not found');
    const incident = serializeIncident(doc);

    const ineligible = ineligibleReason(incident, kind);
    if (ineligible) return fail('not_eligible', ineligible);
    const duplicate = duplicateReason(incident.contactCalls, kind, force);
    if (duplicate) return fail('already_called', duplicate);

    // The dispatcher can edit the script, so it is checked again here.
    const facts = scriptFacts(incident, kind, building);
    const problems = validateScript(script, scriptCheckFor(incident, kind, facts, false));
    if (problems.length) return fail('invalid_script', `Script rejected: ${problems[0]}`, problems);
    const spoken = spokenText(demoMode() ? DEMO_PREAMBLE : null, script);
    const twiml = buildTwiml(spoken);
    if (twiml.length > TWIML_MAX_CHARS) return fail('invalid_script', 'Script is too long for a call.');
    // Template mode (trial): Twilio's own message is played; our script is kept as reviewed, not spoken.
    const mode = voiceMode();
    const heard = mode === 'twiml' ? ('script' as const) : ('trialTemplate' as const);

    const to = normalizePhone(contactPhone(incident));
    if (!to || !allowlist().has(to)) return fail('not_allowed', 'number not on allowlist');

    // Reserve the slot atomically, so two dispatchers can't both place the first call.
    const now = new Date();
    const entry = { kind, status: 'queued', to: lastFour(to), script: spoken, spoken: heard, callSid: '', requestedAt: now, updatedAt: now };
    const slotFree = force
      ? { contactCalls: { $not: { $elemMatch: { kind, status: { $in: [...CONTACT_CALL_ACTIVE] } } } } }
      : { contactCalls: { $not: { $elemMatch: { kind } } } };
    const stillEligible =
      kind === 'alert'
        ? { status: { $ne: 'RESOLVED' as const }, severityScore: { $gte: CONTACT_MIN_SEVERITY } }
        : { status: 'RESOLVED' as const };
    const reserved = await ActiveIncident.updateOne({ _id: id, ...slotFree, ...stillEligible }, { $push: { contactCalls: entry } });
    if (reserved.modifiedCount === 0) return fail('already_called', 'The incident changed or another call was just placed. Refresh and try again.');

    const which = { arrayFilters: [{ 'c.kind': kind, 'c.requestedAt': now }] };
    try {
      const placed = await createCall(config, to, mode === 'twiml' ? { twiml } : { url: TRIAL_TEMPLATE_URL });
      await ActiveIncident.updateOne(
        { _id: id },
        { $set: { 'contactCalls.$[c].callSid': placed.sid, 'contactCalls.$[c].status': placed.status, 'contactCalls.$[c].updatedAt': new Date() } },
        which,
      );
      const call: ContactCall = {
        kind,
        status: placed.status,
        to: lastFour(to),
        script: spoken,
        spoken: heard,
        callSid: placed.sid,
        requestedAt: now.toISOString(),
        updatedAt: new Date().toISOString(),
      };
      console.log('[notify-contact] call placed', { kind, status: placed.status, mode });
      return json({ ok: true, call });
    } catch (err) {
      // Record the failure honestly; nothing was placed.
      await ActiveIncident.updateOne({ _id: id }, { $set: { 'contactCalls.$[c].status': 'failed', 'contactCalls.$[c].updatedAt': new Date() } }, which);
      const e = err instanceof TwilioError ? err : new TwilioError(502, null, 'Twilio request failed.');
      console.error('[notify-contact] Twilio rejected the call', { http: e.httpStatus, code: e.code });
      return fail('upstream', `Twilio did not place the call (HTTP ${e.httpStatus}${e.code !== null ? `, error ${e.code}` : ''}): ${e.message}`);
    }
  } catch (error) {
    console.error('[notify-contact] POST unexpected error:', (error as Error)?.message);
    return fail('upstream', 'Internal server error');
  }
}
