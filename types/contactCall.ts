// Dispatcher-triggered voice calls to a caller's emergency contact (Twilio Programmable Voice).

/** alert: first call while the incident is open. allClear: after it is resolved. */
export type ContactCallKind = 'alert' | 'allClear';

/** Twilio call statuses (https://www.twilio.com/docs/voice/api/call-resource). */
export const CONTACT_CALL_STATUSES = [
  'queued',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
] as const;
export type ContactCallStatus = (typeof CONTACT_CALL_STATUSES)[number];

/** Still happening: polled until it reaches one of the other statuses. */
export const CONTACT_CALL_ACTIVE: readonly ContactCallStatus[] = ['queued', 'ringing', 'in-progress'];
/** The contact did not hear the message: the only outcomes that offer "Call again". */
export const CONTACT_CALL_RETRYABLE: readonly ContactCallStatus[] = ['busy', 'no-answer', 'failed', 'canceled'];

export interface ContactCall {
  kind: ContactCallKind;
  status: ContactCallStatus;
  /** Last 4 digits of the number called, never the full number. */
  to: string;
  /** The script the dispatcher reviewed (spoken twice when `spoken` is "script"). */
  script: string;
  /**
   * What the contact actually heard. "script": our reviewed script (inline TwiML).
   * "trialTemplate": Twilio's own trial message; custom scripts need an upgraded account.
   */
  spoken?: 'script' | 'trialTemplate';
  /** Twilio Call SID; empty when Twilio rejected the request. */
  callSid: string;
  /** ISO 8601. */
  requestedAt: string;
  /** ISO 8601, last status change seen. */
  updatedAt: string;
  /** ISO 8601, when the contact picked up (absent if never answered). */
  answeredAt?: string;
}

// ---- API ----------------------------------------------------------------------------------------

export type ContactCallErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'not_configured'
  | 'not_allowed'
  | 'not_eligible'
  | 'already_called'
  | 'invalid_script'
  | 'upstream';

export type ContactCallError = { ok: false; error: ContactCallErrorCode; message: string; problems?: string[] };

/** POST .../notify-contact/draft */
export type ContactDraftRequest = {
  kind: ContactCallKind;
  /** Building name, only when the dispatcher confirmed it or it is the single building in range. */
  building?: string | null;
};
export type ContactDraftResponse =
  | {
      ok: true;
      /** Fixed opening (demo mode), spoken before the script and not editable. */
      preamble: string | null;
      /** Editable script, at most 70 words. */
      script: string;
      source: 'ai' | 'template';
      model?: string;
      /** Why the deterministic template was used instead of Gemini. */
      templateReason?: string;
    }
  | ContactCallError;

/** POST .../notify-contact */
export type PlaceContactCallRequest = {
  kind: ContactCallKind;
  /** The script as the dispatcher approved it (without the preamble). */
  script: string;
  /** Required for a second call of the same kind. */
  force?: boolean;
};
export type PlaceContactCallResponse = { ok: true; call: ContactCall } | ContactCallError;

/** GET .../notify-contact: availability and the call log (latest entry refreshed from Twilio). */
export type ContactCallStateResponse =
  | {
      ok: true;
      configured: boolean;
      allowlisted: boolean;
      /** False in Twilio template mode (trial): the call plays Twilio's message, not our script. */
      customScript: boolean;
      calls: ContactCall[];
    }
  | ContactCallError;
