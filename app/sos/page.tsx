"use client";

import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppMark } from "@/components/AppMark";

type UiState =
  | "idle"
  | "loading"
  | "fire"
  | "medical"
  | "threat"
  | "unknown"
  | "low-bandwidth";

type ActiveTab = "sos" | "overwatch";

type IceProfile = {
  fullName: string;
  age: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  bloodType: string;
  medicalConditions: string;
  allergies: string;
  mobilityNotes: string;
  sensoryNotes: string;
};

type GpsCoords = { lat: number; lng: number };

type SosPayload = {
  image: string;
  audio: string;
  gps: GpsCoords;
  iceProfile: IceProfile | null;
  sessionId: string;
};

const ICE_STORAGE_KEY = "silentpulse_ice_profile";
const LOCATION_PERMISSION_KEY = "silentpulse_location_permission";
const MEDIA_PERMISSION_KEY = "silentpulse_media_permission";

/** UMass Amherst fallback for local testing when GPS is denied/unavailable */
const FALLBACK_GPS: GpsCoords = {
  lat: 42.3868,
  lng: -72.5301,
};

const LOADING_STATUSES = [
  "Getting your location…",
  "Capturing a photo and a few seconds of audio…",
  "Sending to dispatch…",
] as const;

const ACTIVE_CRISIS_STATES: UiState[] = [
  "fire",
  "medical",
  "threat",
  "unknown",
];
const TELEMETRY_INTERVAL_MS = 30_000;
/** Fast poll for dispatcher status / live message (separate from 30s triage). */
const SESSION_POLL_INTERVAL_MS = 3_000;

type DispatcherMessage = {
  text: string;
  sentAt: string;
  seenAt?: string;
};

function crisisTypeToUiState(crisisType: string): UiState {
  switch (crisisType) {
    case "ENVIRONMENTAL_HAZARD":
    case "FIRE_ENVIRONMENTAL":
      return "fire";
    case "MEDICAL_CRISIS":
      return "medical";
    case "ACTIVE_THREAT":
    case "SECURITY_THREAT":
      return "threat";
    case "UNKNOWN":
    case "UNKNOWN_CRISIS":
      return "unknown";
    case "LOW_BANDWIDTH_SOS":
      return "low-bandwidth";
    default:
      return "unknown";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to convert audio blob to Base64"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Triggers the same kind of native browser permission prompt as getUserMedia
 * for camera/mic. Must be called from a user gesture (button click) for best results.
 */
function requestNativeLocationAccess(
  timeoutMs = 15000,
): Promise<{ ok: boolean; coords: GpsCoords | null; errorCode?: number }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      try {
        localStorage.setItem(LOCATION_PERMISSION_KEY, "unsupported");
      } catch {
        /* ignore */
      }
      resolve({ ok: false, coords: null });
      return;
    }

    // Network/Wi-Fi first — high-accuracy GPS often times out on laptops indoors.
    navigator.geolocation.getCurrentPosition(
      (position) => {
        try {
          localStorage.setItem(LOCATION_PERMISSION_KEY, "granted");
        } catch {
          /* ignore */
        }
        resolve({
          ok: true,
          coords: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
        });
      },
      (error) => {
        console.warn("Native location permission/request failed:", {
          code: error.code,
          message: error.message,
        });
        try {
          // Only mark denied when the user/browser blocked permission.
          // TIMEOUT / POSITION_UNAVAILABLE often still mean permission was allowed.
          localStorage.setItem(
            LOCATION_PERMISSION_KEY,
            error.code === error.PERMISSION_DENIED ? "denied" : "granted",
          );
        } catch {
          /* ignore */
        }
        resolve({ ok: false, coords: null, errorCode: error.code });
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

function getGpsCoordinates(timeoutMs = 10000): Promise<GpsCoords> {
  return new Promise((resolve) => {
    void requestNativeLocationAccess(timeoutMs).then((result) => {
      if (result.ok && result.coords) {
        resolve(result.coords);
        return;
      }
      console.warn(
        "GPS unavailable after native permission prompt — using UMass Amherst fallback",
      );
      resolve(FALLBACK_GPS);
    });
  });
}

function recordAudioBase64(
  stream: MediaStream,
  durationMs = 6000,
): Promise<string> {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    return Promise.resolve("");
  }

  const audioStream = new MediaStream(audioTracks);
  const preferredMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";

  const recorder = preferredMime
    ? new MediaRecorder(audioStream, { mimeType: preferredMime })
    : new MediaRecorder(audioStream);

  const chunks: BlobPart[] = [];

  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = () => reject(new Error("MediaRecorder failed"));

    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      blobToBase64(blob).then(resolve).catch(reject);
    };

    recorder.start();
    window.setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);
  });
}

/* ------------------------------------------------------------------ */
/* Icons — simple filled glyphs in the spirit of SF Symbols.           */
/* ------------------------------------------------------------------ */

function FlameIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.6 2.2c.5 3-1.3 4.6-2.7 6.2C8.4 10 7 11.8 7 14.6 7 18.1 9.3 21 12.4 21c3.3 0 5.6-2.6 5.6-6.1 0-2.7-1.3-4.6-2.6-6.1-.2 1.4-.9 2.6-2 3.2.6-3.4-.3-7.1-.8-9.8Z" />
    </svg>
  );
}

function MedicalIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9.5 3h5a1 1 0 0 1 1 1v4.5H20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-4.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4.5H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h4.5V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function ShieldIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.5 4.5 5.3v5.9c0 4.9 3.2 9.2 7.5 10.3 4.3-1.1 7.5-5.4 7.5-10.3V5.3L12 2.5Z" />
    </svg>
  );
}

function QuestionIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 9.2a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.8v.7" />
      <circle cx="12" cy="18" r="0.6" fill="currentColor" />
    </svg>
  );
}

function WeakSignalIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M2.5 8.8a14 14 0 0 1 19 0" opacity="0.35" />
      <path d="M5.5 12.2a9.5 9.5 0 0 1 13 0" opacity="0.35" />
      <path d="M8.7 15.5a5 5 0 0 1 6.6 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
      <path d="M4 3.5 20 20.5" />
    </svg>
  );
}

function CheckIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function WarningIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M10.3 3.6a2 2 0 0 1 3.4 0l8 13.9A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3L10.3 3.6ZM12 8.5a1 1 0 0 0-1 1v4.2a1 1 0 1 0 2 0V9.5a1 1 0 0 0-1-1Zm0 9.3a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z" />
    </svg>
  );
}

function PersonIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" />
      <circle cx="12" cy="10" r="3.1" />
      <path d="M6.6 18.4c1.3-2.1 3.1-3.2 5.4-3.2s4.1 1.1 5.4 3.2" />
    </svg>
  );
}

function SosTabIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M12 6.8v6.4" stroke="#1c1c1e" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="12" cy="16.8" r="1.4" fill="#1c1c1e" />
    </svg>
  );
}

function LocationIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.6 3.4a.8.8 0 0 1 .2.9l-7 16.4a.8.8 0 0 1-1.5-.1l-1.9-6.9-6.9-1.9a.8.8 0 0 1-.1-1.5l16.4-7a.8.8 0 0 1 .8.1Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Crisis building blocks                                              */
/* ------------------------------------------------------------------ */

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Dispatcher → caller live message. Shown on every crisis screen above existing
 * content. Stealth (discreet): dim low-contrast text only — no flash/animation.
 */
function DispatcherMessageBanner({
  message,
  discreet = false,
}: {
  message: DispatcherMessage;
  discreet?: boolean;
}) {
  const time = formatMessageTime(message.sentAt);
  return (
    <div
      role="status"
      aria-live={discreet ? "off" : "polite"}
      className={`mb-5 ${
        discreet
          ? "border-l border-label-3/40 pl-3"
          : "rounded-2xl bg-black/30 p-4 ring-1 ring-white/20"
      }`}
    >
      <p
        className={`text-xs font-semibold tracking-wide ${
          discreet ? "text-label-3/70" : "text-white/70"
        }`}
      >
        From dispatcher{time ? ` · ${time}` : ""}
      </p>
      <p
        className={`mt-1 text-base font-semibold leading-snug ${
          discreet ? "text-label-3" : "text-white"
        }`}
      >
        {message.text}
      </p>
    </div>
  );
}

/** Floating pill at the top of every active crisis screen. */
function TransmittingPill({ discreet = false }: { discreet?: boolean }) {
  return (
    <div
      className={`absolute left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold ${
        discreet
          ? "bg-surface/60 text-label-3"
          : "bg-black/25 text-white backdrop-blur-md"
      }`}
    >
      {!discreet && (
        <span
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      Sending location and details to dispatch
    </div>
  );
}

/** Full-bleed crisis screen: colored surface, top-aligned content, quiet footer. */
function CrisisScreen({
  className,
  children,
  footer,
}: {
  className: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div
      className={`relative flex h-full w-full animate-screen-in flex-col overflow-y-auto px-6 pb-4 pt-[calc(env(safe-area-inset-top)+4.25rem)] motion-reduce:animate-none md:px-10 ${className}`}
    >
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
        {children}
        <div className="mt-auto flex flex-col items-center pt-6">{footer}</div>
      </div>
    </div>
  );
}

function CrisisHeader({
  icon,
  title,
  subtitle,
  discreet = false,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  discreet?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div
        className={`grid h-14 w-14 place-items-center rounded-full ${
          discreet ? "bg-surface text-label-3" : "bg-white/15 text-white"
        }`}
      >
        {icon}
      </div>
      <div role="status" aria-live="assertive" className="space-y-2">
        <h1
          className={`text-[1.75rem] font-bold leading-tight tracking-tight ${
            discreet ? "text-label-2" : "text-white"
          }`}
        >
          {title}
        </h1>
        <p
          className={`text-base leading-snug ${
            discreet ? "text-label-3" : "text-white/85"
          }`}
        >
          {subtitle}
        </p>
      </div>
    </div>
  );
}

/** Master quick-action map for all 4 AI classifications (aliases → uiState). */
const QUICK_ACTIONS_BY_CLASSIFICATION = {
  SECURITY_THREAT: [
    "Armed Intruder",
    "Following Me",
    "Domestic Violence",
    "I don't know",
  ],
  MEDICAL_CRISIS: [
    "Chest Pain",
    "Asthma / Breathing",
    "Severe Bleeding",
    "I don't know",
  ],
  FIRE_ENVIRONMENTAL: [
    "Trapped / Blocked",
    "Smoke Inhalation",
    "Chemical Spill",
    "I don't know",
  ],
  UNKNOWN_CRISIS: [
    "Need Help IMMEDIATELY!",
    "Not Immediate / Non-Emergency",
    "Accidental Trigger",
    "I don't know",
  ],
} as const;

const URGENT_QUICK_ACTION = "Need Help IMMEDIATELY!";

/**
 * What people see on each quick action. The original value is still what's
 * sent to dispatch, so the backend and dashboard see the same strings as before.
 */
const QUICK_ACTION_LABELS: Record<string, string> = {
  "Armed Intruder": "Armed intruder",
  "Following Me": "Someone is following me",
  "Domestic Violence": "Domestic violence",
  "Chest Pain": "Chest pain",
  "Asthma / Breathing": "Trouble breathing",
  "Severe Bleeding": "Severe bleeding",
  "Trapped / Blocked": "I'm trapped",
  "Smoke Inhalation": "Breathing in smoke",
  "Chemical Spill": "Chemical spill",
  "Need Help IMMEDIATELY!": "I need help now",
  "Not Immediate / Non-Emergency": "Not an emergency",
  "Accidental Trigger": "Pressed by accident",
};

function quickActionLabel(action: string): string {
  return QUICK_ACTION_LABELS[action] ?? action;
}

function quickActionsForUiState(uiState: UiState): readonly string[] {
  switch (uiState) {
    case "threat":
      return QUICK_ACTIONS_BY_CLASSIFICATION.SECURITY_THREAT;
    case "medical":
      return QUICK_ACTIONS_BY_CLASSIFICATION.MEDICAL_CRISIS;
    case "fire":
      return QUICK_ACTIONS_BY_CLASSIFICATION.FIRE_ENVIRONMENTAL;
    case "unknown":
      return QUICK_ACTIONS_BY_CLASSIFICATION.UNKNOWN_CRISIS;
    default:
      return [];
  }
}

function formatContextLabel(context: string): string {
  if (context === "NO_RESPONSE_RECEIVED") return "No answer";
  return quickActionLabel(context);
}

/** Sent to /api/triage/context when the person cancels from a crisis screen. */
const USER_CANCELLED_CONTEXT = "USER_CANCELLED_SAFE";

function CrisisDispatcherStatus({
  dispatcherStatus,
  userProvidedContext,
  discreet = false,
}: {
  dispatcherStatus: "reviewing" | "dispatched";
  userProvidedContext: string | null;
  discreet?: boolean;
}) {
  const dispatched = dispatcherStatus === "dispatched";
  return (
    <div
      className={`mt-8 rounded-3xl p-5 ${
        discreet ? "bg-surface" : "bg-black/20 ring-1 ring-white/15"
      }`}
    >
      <div role="status" aria-live="assertive" className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
            dispatched
              ? "bg-safe text-black"
              : discreet
                ? "bg-surface-2 text-label-3"
                : "bg-white/20 text-white"
          }`}
          aria-hidden="true"
        >
          {dispatched ? (
            <CheckIcon />
          ) : (
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                discreet
                  ? "bg-label-3"
                  : "animate-pulse bg-white motion-reduce:animate-none"
              }`}
            />
          )}
        </span>
        <div className="space-y-1">
          <p
            className={`text-[1.375rem] font-bold leading-tight ${
              discreet ? "text-label-2" : "text-white"
            }`}
          >
            {dispatched ? "Help is on the way" : "Dispatch has your alert"}
          </p>
          <p
            className={`text-base leading-snug ${
              discreet ? "text-label-3" : "text-white/85"
            }`}
          >
            {dispatched
              ? "Responders have been sent to your location."
              : "A dispatcher is reviewing your situation now."}
          </p>
        </div>
      </div>
      {userProvidedContext && (
        <p
          className={`mt-4 border-t pt-3 text-sm ${
            discreet
              ? "border-separator text-label-3"
              : "border-white/15 text-white/85"
          }`}
        >
          You told dispatch: {formatContextLabel(userProvidedContext)}
        </p>
      )}
    </div>
  );
}

function QuickActionMenu({
  actions,
  countdown,
  onSelect,
  surface,
}: {
  actions: readonly string[];
  countdown: number;
  onSelect: (selection: string) => void;
  /** "color" = on an orange/blue fill; "dark" = on black or gray; "discreet" = threat mode */
  surface: "color" | "dark" | "discreet";
}) {
  return (
    <section className="mt-8 space-y-3" aria-labelledby="quick-actions-title">
      <h2
        id="quick-actions-title"
        className={`text-lg font-semibold ${
          surface === "discreet" ? "text-label-2" : "text-white"
        }`}
      >
        What&apos;s happening?
      </h2>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {actions.map((action) => {
          const isUrgent = action === URGENT_QUICK_ACTION;
          return (
            <button
              key={action}
              type="button"
              onClick={() => onSelect(action)}
              className={`min-h-14 rounded-2xl px-5 py-3.5 text-left text-base font-semibold transition active:scale-[0.98] active:opacity-80 ${
                isUrgent
                  ? "bg-sos text-white"
                  : surface === "color"
                    ? "bg-black/20 text-white ring-1 ring-white/20"
                    : surface === "discreet"
                      ? "bg-surface text-label-2"
                      : "bg-surface-2 text-white"
              }`}
            >
              {quickActionLabel(action)}
            </button>
          );
        })}
      </div>
      <div role="status" aria-live="assertive">
        <p
          className={`text-sm ${
            surface === "color"
              ? "text-white/85"
              : surface === "discreet"
                ? "text-label-3"
                : "text-label-2"
          }`}
        >
          Sending without details in {countdown}s
        </p>
      </div>
    </section>
  );
}

function CancelSosButton({
  onCancel,
  surface = "color",
}: {
  onCancel: () => void;
  surface?: "color" | "dark" | "discreet";
}) {
  return (
    <button
      type="button"
      onClick={onCancel}
      className={`min-h-[44px] rounded-full p-2.5 px-5 text-base font-semibold transition active:opacity-60 ${
        surface === "color"
          ? "text-white/85"
          : surface === "discreet"
            ? "text-label-3"
            : "text-label-2"
      }`}
    >
      I&apos;m safe — Cancel SOS
    </button>
  );
}

/** Ring that drains over the 5-second grace period. */
function CountdownRing({ countdown, total }: { countdown: number; total: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, countdown / total));
  return (
    <div className="relative grid h-[min(62vmin,15rem)] w-[min(62vmin,15rem)] place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeWidth="6" className="text-sos/25" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className="text-sos transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
        />
      </svg>
      <span className="text-[5.5rem] font-bold leading-none tracking-tight text-white tabular-nums">
        {countdown}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation + readiness (adaptive: tab bar on iPhone, sidebar on Mac) */
/* ------------------------------------------------------------------ */

const NAV_ITEMS = [
  { tab: "sos" as const, label: "SOS", Icon: SosTabIcon },
  { tab: "overwatch" as const, label: "Safe Walk", shortLabel: "Walk", Icon: LocationIcon },
];

function AppSidebar({
  activeTab,
  onSelect,
}: {
  activeTab: ActiveTab;
  onSelect: (tab: ActiveTab) => void;
}) {
  return (
    <aside
      className="material relative z-40 hidden w-64 shrink-0 flex-col border-r border-white/10 px-3 pb-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] md:flex"
      aria-label="SilentPulse"
    >
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <AppMark className="h-8 w-8" />
        <span className="text-[1.0625rem] font-semibold tracking-tight">
          SilentPulse
        </span>
      </div>

      <nav aria-label="Sections" className="space-y-0.5">
        {NAV_ITEMS.map(({ tab, label, Icon }) => {
          const selected = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelect(tab)}
              className={`flex min-h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[0.9375rem] font-medium transition-colors ${
                selected
                  ? "bg-white/10 text-white"
                  : "text-label-2 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon
                className={`h-5 w-5 ${tab === "sos" ? "text-sos" : selected ? "text-white" : "text-label-3"}`}
              />
              {label}
            </button>
          );
        })}
      </nav>

      <p className="mt-6 px-2.5 pb-1.5 text-xs font-semibold text-label-3">
        Settings
      </p>
      <Link
        href="/?edit=true"
        className="flex min-h-9 items-center gap-3 rounded-lg px-2.5 text-[0.9375rem] font-medium text-label-2 transition-colors hover:bg-white/5 hover:text-white"
      >
        <PersonIcon className="h-5 w-5 text-label-3" />
        Emergency Profile
      </Link>
    </aside>
  );
}

function AppTabBar({
  activeTab,
  onSelect,
}: {
  activeTab: ActiveTab;
  onSelect: (tab: ActiveTab) => void;
}) {
  return (
    <nav
      className="material relative z-50 shrink-0 border-t border-white/10 pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="Sections"
    >
      <div className="mx-auto grid h-14 max-w-lg grid-cols-2" role="tablist">
        {NAV_ITEMS.map(({ tab, label, shortLabel, Icon }) => {
          const selected = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(tab)}
              className={`flex flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors ${
                selected ? "text-white" : "text-label-3"
              }`}
            >
              <Icon className="h-6 w-6" />
              {shortLabel ?? label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

type ReadinessState = "ok" | "warn" | "todo";

type ReadinessItem = {
  key: string;
  title: string;
  shortTitle: string;
  state: ReadinessState;
  status: string;
  icon: ReactNode;
};

function readinessTone(state: ReadinessState) {
  return state === "ok"
    ? "text-safe"
    : state === "warn"
      ? "text-warn"
      : "text-label-3";
}

function ReadinessGlyph({ state }: { state: ReadinessState }) {
  if (state === "ok") return <CheckIcon className="h-4 w-4" />;
  if (state === "warn") return <WarningIcon className="h-4 w-4" />;
  return (
    <span className="block h-2 w-2 rounded-full border-[1.5px] border-current" aria-hidden="true" />
  );
}

/** Desktop: a full card beside HELP. */
function ReadinessCard({ items }: { items: ReadinessItem[] }) {
  const allReady = items.every((item) => item.state === "ok");
  return (
    <section
      aria-labelledby="readiness-title"
      className="w-full max-w-sm rounded-3xl bg-surface p-2 ring-1 ring-white/5"
    >
      <div className="px-4 pb-2 pt-4">
        <h2 id="readiness-title" className="text-lg font-semibold tracking-tight">
          Readiness
        </h2>
        <p className="mt-0.5 text-sm text-label-2">
          {allReady
            ? "Everything dispatch needs is set up."
            : "Finish setup so dispatch gets everything instantly."}
        </p>
      </div>
      <ul className="divide-y divide-separator">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-label-2">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 text-[0.9375rem] font-medium">
              {item.title}
            </span>
            <span
              className={`flex items-center gap-1.5 text-sm font-medium ${readinessTone(item.state)}`}
            >
              <ReadinessGlyph state={item.state} />
              {item.status}
            </span>
          </li>
        ))}
      </ul>
      {!allReady && (
        <div className="px-2 pb-2 pt-1">
          <Link
            href="/?edit=true"
            className="flex min-h-11 items-center justify-center rounded-2xl bg-surface-2 text-[0.9375rem] font-semibold text-tint transition-colors hover:bg-separator"
          >
            Finish Setup
          </Link>
        </div>
      )}
    </section>
  );
}

/** iPhone: a compact row of status chips under HELP. */
function ReadinessChips({ items }: { items: ReadinessItem[] }) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-2" aria-label="Readiness">
      {items.map((item) => {
        const chip = (
          <span
            className={`flex min-h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-xs font-medium ${readinessTone(item.state)}`}
          >
            <ReadinessGlyph state={item.state} />
            <span className="text-label-2">{item.shortTitle}</span>
            <span className="sr-only">: {item.status}</span>
          </span>
        );
        return (
          <li key={item.key}>
            {item.state === "ok" ? (
              chip
            ) : (
              <Link href="/?edit=true" className="block rounded-full">
                {chip}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CameraIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9Zm13.5 2.2 2.9-2a1 1 0 0 1 1.6.8v7a1 1 0 0 1-1.6.8l-2.9-2V9.7Z" />
    </svg>
  );
}

function SosPageContent() {
  const [uiState, setUiState] = useState<UiState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("sos");
  const [isSafeWalkArmed, setIsSafeWalkArmed] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [userProvidedContext, setUserProvidedContext] = useState<string | null>(
    null,
  );
  const [quickActionCountdown, setQuickActionCountdown] = useState(10);
  const [dispatcherStatus, setDispatcherStatus] = useState<
    "reviewing" | "dispatched"
  >("reviewing");
  const [dispatcherMessage, setDispatcherMessage] =
    useState<DispatcherMessage | null>(null);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [loadingStatusIndex, setLoadingStatusIndex] = useState(0);
  const [locationPermission, setLocationPermission] = useState<
    "unknown" | "granted" | "denied" | "unsupported"
  >("unknown");
  const [liveGps, setLiveGps] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasAutoTriggered = useRef(false);
  const sosInFlightRef = useRef(false);
  const watchIdRef = useRef<number | null>(null);
  const telemetryIntervalRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const quickActionIntervalRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const userProvidedContextRef = useRef<string | null>(null);
  const incidentIdRef = useRef<string | null>(null);
  const seenMessageSentAtRef = useRef<string | null>(null);
  const sessionPollIntervalRef = useRef<number | null>(null);
  const [mediaPermission, setMediaPermission] = useState<string | null>(null);
  const [hasProfile, setHasProfile] = useState(false);

  // Readiness: what dispatch will get instantly (read once from this device)
  useEffect(() => {
    try {
      setMediaPermission(localStorage.getItem(MEDIA_PERMISSION_KEY));
      const saved = JSON.parse(
        localStorage.getItem(ICE_STORAGE_KEY) || "{}",
      ) as Partial<IceProfile>;
      setHasProfile(Boolean(saved.fullName && saved.emergencyContactPhone));
    } catch {
      /* storage unavailable — show as not set up */
    }
  }, []);

  const clearTelemetryInterval = useCallback(() => {
    if (telemetryIntervalRef.current !== null) {
      window.clearInterval(telemetryIntervalRef.current);
      telemetryIntervalRef.current = null;
    }
  }, []);

  const clearSessionPollInterval = useCallback(() => {
    if (sessionPollIntervalRef.current !== null) {
      window.clearInterval(sessionPollIntervalRef.current);
      sessionPollIntervalRef.current = null;
    }
  }, []);

  const clearCountdownInterval = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const applyDispatcherMessage = useCallback(
    (next: DispatcherMessage | null | undefined) => {
      if (!next?.text || !next.sentAt) {
        setDispatcherMessage(null);
        return;
      }
      setDispatcherMessage({
        text: next.text,
        sentAt: next.sentAt,
        ...(next.seenAt ? { seenAt: next.seenAt } : {}),
      });
    },
    [],
  );

  const captureAndSendTelemetry = useCallback(
    async (
      currentSessionId: string,
      options: { updateUi: boolean } = { updateUi: false },
    ): Promise<UiState | null> => {
      if (sosInFlightRef.current) return null;
      sosInFlightRef.current = true;

      let stream: MediaStream | null = null;

      try {
        const gpsPromise = getGpsCoordinates();

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: true,
        });

        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) {
          throw new Error("Hidden video/canvas elements are unavailable");
        }

        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();

        if (video.readyState < 2) {
          await new Promise<void>((resolve) => {
            video.onloadeddata = () => resolve();
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 150));

        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not get canvas 2D context");
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL("image/jpeg", 0.5);

        const [audio, gps] = await Promise.all([
          recordAudioBase64(stream, 6000),
          gpsPromise,
        ]);

        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        video.srcObject = null;

        const savedProfile = localStorage.getItem(ICE_STORAGE_KEY);
        const iceProfile = JSON.parse(savedProfile || "{}") as IceProfile;

        const payload: SosPayload = {
          image,
          audio,
          gps,
          iceProfile,
          sessionId: currentSessionId,
        };

        console.log("SOS Payload:", payload);

        const response = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image,
            audio,
            gps,
            iceProfile: JSON.parse(savedProfile || "{}"),
            sessionId: currentSessionId,
            userId: "user_demo_01",
            imageBase64: image,
            audioBase64: audio,
          }),
        });

        if (!response.ok) {
          throw new Error(`Triage API failed with status ${response.status}`);
        }

        const data = (await response.json()) as {
          crisisType?: string;
          sessionId?: string;
          incidentId?: string;
          dispatcherStatus?: "reviewing" | "dispatched" | "resolved";
          dispatcherMessage?: DispatcherMessage;
        };
        if (!data.crisisType) {
          throw new Error("Triage API returned no crisisType");
        }

        const resolvedSessionId = data.sessionId || currentSessionId;
        setActiveSessionId(resolvedSessionId);
        sessionIdRef.current = resolvedSessionId;
        setSessionId(resolvedSessionId);

        if (data.incidentId) {
          incidentIdRef.current = data.incidentId;
          setIncidentId(data.incidentId);
        }

        if (data.dispatcherStatus === "dispatched") {
          setDispatcherStatus("dispatched");
        } else if (data.dispatcherStatus === "reviewing") {
          setDispatcherStatus("reviewing");
        }

        applyDispatcherMessage(data.dispatcherMessage);

        const nextState = crisisTypeToUiState(data.crisisType);
        if (options.updateUi) {
          setUiState(nextState);
        }
        return nextState;
      } catch (error) {
        console.error("Telemetry capture/send failed:", error);
        if (options.updateUi) {
          setUiState("low-bandwidth");
        }
        return options.updateUi ? "low-bandwidth" : null;
      } finally {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
        sosInFlightRef.current = false;
      }
    },
    [applyDispatcherMessage],
  );

  const triggerSOS = useCallback(async () => {
    if (sosInFlightRef.current) return;

    const newSessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Date.now().toString();

    sessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
    setActiveSessionId(newSessionId);
    userProvidedContextRef.current = null;
    setUserProvidedContext(null);
    incidentIdRef.current = null;
    setIncidentId(null);
    seenMessageSentAtRef.current = null;
    setDispatcherMessage(null);
    setQuickActionCountdown(10);
    setDispatcherStatus("reviewing");
    setActiveTab("sos");
    setUiState("loading");

    await captureAndSendTelemetry(newSessionId, { updateUi: true });
  }, [captureAndSendTelemetry]);

  const handleQuickAction = useCallback(
    async (selection: string) => {
      if (userProvidedContextRef.current) return;

      userProvidedContextRef.current = selection;
      setUserProvidedContext(selection);

      if (quickActionIntervalRef.current !== null) {
        window.clearInterval(quickActionIntervalRef.current);
        quickActionIntervalRef.current = null;
      }

      const sessionForContext =
        activeSessionId ?? sessionIdRef.current ?? sessionId;

      try {
        await fetch("/api/triage/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionForContext,
            userContext: selection,
          }),
        });
      } catch (error) {
        console.error("Quick-action context send failed:", error);
      }
    },
    [activeSessionId, sessionId],
  );

  const cancelSosCountdown = useCallback(() => {
    clearCountdownInterval();
    setIsCountingDown(false);
    setCountdown(5);
    setActiveTab("sos");
    setUiState("idle");
  }, [clearCountdownInterval]);

  const startSosCountdown = useCallback(() => {
    if (sosInFlightRef.current || countdownIntervalRef.current !== null) return;

    // Same pattern as camera/mic: request native browser permission from the
    // HELP click (user gesture) so Chrome/Safari show the system dialog.
    void requestNativeLocationAccess().then((result) => {
      setLocationPermission(result.ok ? "granted" : "denied");
    });

    setActiveTab("sos");
    setUiState("idle");
    setCountdown(5);
    setIsCountingDown(true);

    countdownIntervalRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearCountdownInterval();
          setIsCountingDown(false);
          setCountdown(5);
          // Fire telemetry after the grace period completes
          void triggerSOS();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [clearCountdownInterval, triggerSOS]);

  const resetSession = useCallback(() => {
    clearCountdownInterval();
    clearTelemetryInterval();
    clearSessionPollInterval();
    if (quickActionIntervalRef.current !== null) {
      window.clearInterval(quickActionIntervalRef.current);
      quickActionIntervalRef.current = null;
    }
    sessionIdRef.current = null;
    userProvidedContextRef.current = null;
    incidentIdRef.current = null;
    seenMessageSentAtRef.current = null;
    setSessionId(null);
    setActiveSessionId(null);
    setUserProvidedContext(null);
    setIncidentId(null);
    setDispatcherMessage(null);
    setQuickActionCountdown(10);
    setDispatcherStatus("reviewing");
    setIsCountingDown(false);
    setCountdown(5);
    setActiveTab("sos");
    setUiState("idle");
  }, [clearCountdownInterval, clearTelemetryInterval, clearSessionPollInterval]);

  // "I'm safe" exit from an active crisis: tell dispatch, then stop telemetry.
  const cancelActiveSos = useCallback(async () => {
    const confirmed = window.confirm(
      "Cancel SOS? Dispatch will be told you're safe.",
    );
    if (!confirmed) return;

    const sessionForCancel = sessionIdRef.current ?? activeSessionId ?? sessionId;
    resetSession();

    if (!sessionForCancel) return;
    try {
      await fetch("/api/triage/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionForCancel,
          userContext: USER_CANCELLED_CONTEXT,
        }),
      });
    } catch (error) {
      console.error("SOS cancel send failed:", error);
    }
  }, [activeSessionId, sessionId, resetSession]);

  // Apple Lock Screen shortcut: /sos?auto=true still gets a 5s cancel window
  useEffect(() => {
    if (searchParams.get("auto") === "true" && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      startSosCountdown();
    }
  }, [searchParams, startSosCountdown]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_PERMISSION_KEY);
      if (saved === "granted" || saved === "denied" || saved === "unsupported") {
        setLocationPermission(saved);
      }
    } catch {
      setLocationPermission("unknown");
    }

    // Reflect live browser permission state when Permissions API is available
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((status) => {
          if (status.state === "granted") {
            setLocationPermission("granted");
            localStorage.setItem(LOCATION_PERMISSION_KEY, "granted");
          } else if (status.state === "denied") {
            setLocationPermission("denied");
            localStorage.setItem(LOCATION_PERMISSION_KEY, "denied");
          }
          status.onchange = () => {
            if (status.state === "granted") {
              setLocationPermission("granted");
              localStorage.setItem(LOCATION_PERMISSION_KEY, "granted");
            } else if (status.state === "denied") {
              setLocationPermission("denied");
              localStorage.setItem(LOCATION_PERMISSION_KEY, "denied");
            }
          };
        })
        .catch(() => {
          /* Permissions API unavailable — ignore */
        });
    }
  }, []);

  useEffect(() => {
    return () => {
      clearCountdownInterval();
      if (quickActionIntervalRef.current !== null) {
        window.clearInterval(quickActionIntervalRef.current);
        quickActionIntervalRef.current = null;
      }
    };
  }, [clearCountdownInterval]);

  // 10s quick-action menu timeout while crisis is active and no context yet
  useEffect(() => {
    const menuVisible =
      ACTIVE_CRISIS_STATES.includes(uiState) && userProvidedContext === null;

    if (quickActionIntervalRef.current !== null) {
      window.clearInterval(quickActionIntervalRef.current);
      quickActionIntervalRef.current = null;
    }

    if (!menuVisible) {
      return;
    }

    setQuickActionCountdown(10);

    quickActionIntervalRef.current = window.setInterval(() => {
      setQuickActionCountdown((prev) => {
        if (prev <= 1) {
          if (quickActionIntervalRef.current !== null) {
            window.clearInterval(quickActionIntervalRef.current);
            quickActionIntervalRef.current = null;
          }
          void handleQuickAction("NO_RESPONSE_RECEIVED");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (quickActionIntervalRef.current !== null) {
        window.clearInterval(quickActionIntervalRef.current);
        quickActionIntervalRef.current = null;
      }
    };
  }, [uiState, userProvidedContext, handleQuickAction]);

  // Rotate high-tech status lines while capturing / transmitting
  useEffect(() => {
    if (uiState !== "loading") {
      setLoadingStatusIndex(0);
      return;
    }

    const id = window.setInterval(() => {
      setLoadingStatusIndex((index) => (index + 1) % LOADING_STATUSES.length);
    }, 1800);

    return () => window.clearInterval(id);
  }, [uiState]);

  // Autonomous continuous telemetry every 30s during active crises
  useEffect(() => {
    clearTelemetryInterval();

    const activeSession = sessionIdRef.current ?? sessionId;
    const shouldLoop =
      ACTIVE_CRISIS_STATES.includes(uiState) && Boolean(activeSession);

    if (!shouldLoop || !activeSession) {
      return;
    }

    telemetryIntervalRef.current = window.setInterval(() => {
      const id = sessionIdRef.current ?? activeSession;
      if (!id) return;
      void captureAndSendTelemetry(id, { updateUi: false });
    }, TELEMETRY_INTERVAL_MS);

    return () => {
      clearTelemetryInterval();
    };
  }, [uiState, sessionId, captureAndSendTelemetry, clearTelemetryInterval]);

  // Lightweight session poll (~3s) for dispatcher status + live message
  useEffect(() => {
    clearSessionPollInterval();

    const activeSession = sessionIdRef.current ?? sessionId;
    const shouldPoll =
      ACTIVE_CRISIS_STATES.includes(uiState) && Boolean(activeSession);

    if (!shouldPoll || !activeSession) {
      return;
    }

    const poll = async () => {
      const sid = sessionIdRef.current ?? activeSession;
      if (!sid) return;
      try {
        const res = await fetch(
          `/api/incidents/session?sessionId=${encodeURIComponent(sid)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          _id?: string;
          dispatcherStatus?: "reviewing" | "dispatched" | "resolved";
          dispatcherMessage?: DispatcherMessage;
        };
        if (data._id) {
          incidentIdRef.current = data._id;
          setIncidentId(data._id);
        }
        if (data.dispatcherStatus === "dispatched") {
          setDispatcherStatus("dispatched");
        } else if (data.dispatcherStatus === "reviewing") {
          setDispatcherStatus("reviewing");
        }
        applyDispatcherMessage(data.dispatcherMessage ?? null);
      } catch (error) {
        console.error("Session poll failed:", error);
      }
    };

    void poll();
    sessionPollIntervalRef.current = window.setInterval(
      () => void poll(),
      SESSION_POLL_INTERVAL_MS,
    );

    return () => {
      clearSessionPollInterval();
    };
  }, [
    uiState,
    sessionId,
    applyDispatcherMessage,
    clearSessionPollInterval,
  ]);

  // Report seenAt once when a new dispatcher message is first displayed
  useEffect(() => {
    if (!dispatcherMessage?.text || !dispatcherMessage.sentAt) return;
    if (seenMessageSentAtRef.current === dispatcherMessage.sentAt) return;
    if (dispatcherMessage.seenAt) {
      seenMessageSentAtRef.current = dispatcherMessage.sentAt;
      return;
    }

    const id = incidentIdRef.current ?? incidentId;
    if (!id) return;

    seenMessageSentAtRef.current = dispatcherMessage.sentAt;
    void fetch(`/api/incidents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dispatcherMessageSeen: true }),
    }).catch((error) => {
      console.error("dispatcherMessage seen report failed:", error);
      // Allow a retry on the next render/poll if the report failed.
      if (seenMessageSentAtRef.current === dispatcherMessage.sentAt) {
        seenMessageSentAtRef.current = null;
      }
    });
  }, [dispatcherMessage, incidentId]);

  // Live GPS readout while Safe Walk / Overwatch is armed
  useEffect(() => {
    if (!isSafeWalkArmed) {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    if (!navigator.geolocation) {
      setLiveGps(null);
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setLiveGps({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        // Keep last known coords on transient GPS errors
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [isSafeWalkArmed]);

  function ensureSessionForSim() {
    userProvidedContextRef.current = null;
    setUserProvidedContext(null);
    seenMessageSentAtRef.current = null;
    setDispatcherMessage(null);
    setQuickActionCountdown(10);

    if (sessionIdRef.current) {
      setActiveSessionId(sessionIdRef.current);
      return;
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Date.now().toString();
    sessionIdRef.current = id;
    setSessionId(id);
    setActiveSessionId(id);
  }

  const readinessItems: ReadinessItem[] = [
    {
      key: "location",
      title: "Location",
      shortTitle: "Location",
      state:
        locationPermission === "granted"
          ? "ok"
          : locationPermission === "unknown"
            ? "todo"
            : "warn",
      status:
        locationPermission === "granted"
          ? "On"
          : locationPermission === "denied"
            ? "Blocked"
            : locationPermission === "unsupported"
              ? "Unavailable"
              : "Not set up",
      icon: <LocationIcon className="h-5 w-5" />,
    },
    {
      key: "media",
      title: "Camera and Microphone",
      shortTitle: "Camera",
      state:
        mediaPermission === "granted"
          ? "ok"
          : mediaPermission === null || mediaPermission === "idle"
            ? "todo"
            : "warn",
      status:
        mediaPermission === "granted"
          ? "On"
          : mediaPermission === "denied"
            ? "Blocked"
            : mediaPermission === null || mediaPermission === "idle"
              ? "Not set up"
              : "Unavailable",
      icon: <CameraIcon />,
    },
    {
      key: "profile",
      title: "Emergency Profile",
      shortTitle: "Profile",
      state: hasProfile ? "ok" : "todo",
      status: hasProfile ? "Added" : "Not set up",
      icon: <PersonIcon className="h-5 w-5" />,
    },
  ];

  return (
    <main className="relative flex h-dvh w-screen overflow-hidden bg-black text-white">
      {/* Hidden capture surfaces for getUserMedia → canvas snapshot */}
      <video
        ref={videoRef}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        playsInline
        muted
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
      />

      <AppSidebar activeTab={activeTab} onSelect={setActiveTab} />

      <div className="relative flex min-w-0 flex-1 flex-col">

      {/* Main content — fills the space above the sim row + bottom tabs */}
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        {activeTab === "sos" && (
          <>
            {/* ---------- Grace period: 5s to cancel ---------- */}
            {uiState === "idle" && isCountingDown && (
              <div className="flex h-full w-full animate-screen-in flex-col items-center px-6 pb-6 pt-[calc(env(safe-area-inset-top)+3rem)] text-center motion-reduce:animate-none md:pb-12">
                <div
                  role="status"
                  aria-live="assertive"
                  className="flex flex-1 flex-col items-center justify-center gap-8"
                >
                  <div className="space-y-2">
                    <h1 className="text-[1.75rem] font-bold tracking-tight">
                      Calling for help
                    </h1>
                    <p className="mx-auto max-w-xs text-base text-label-2">
                      Dispatch will get your location and details
                      automatically.
                    </p>
                  </div>
                  <CountdownRing countdown={countdown} total={5} />
                </div>
                <button
                  type="button"
                  onClick={cancelSosCountdown}
                  className="min-h-14 w-full max-w-sm rounded-full bg-white px-8 text-lg font-semibold text-black transition active:scale-[0.98] active:opacity-80"
                >
                  Cancel SOS
                </button>
              </div>
            )}

            {/* ---------- Idle: HELP ---------- */}
            {uiState === "idle" && !isCountingDown && (
              <div className="flex h-full w-full animate-screen-in flex-col overflow-y-auto px-5 pt-[calc(env(safe-area-inset-top)+0.5rem)] motion-reduce:animate-none md:px-10 md:pt-[calc(env(safe-area-inset-top)+1.5rem)]">
                {/* iPhone header — on Mac the sidebar carries brand + profile */}
                <header className="flex min-h-11 items-center justify-between md:hidden">
                  <div className="flex items-center gap-2.5">
                    <AppMark className="h-7 w-7" />
                    <p className="text-lg font-semibold tracking-tight">
                      SilentPulse
                    </p>
                  </div>
                  <Link
                    href="/?edit=true"
                    className="grid h-11 w-11 place-items-center rounded-full bg-surface text-label-2 transition active:opacity-60"
                    aria-label="Edit emergency profile"
                  >
                    <PersonIcon />
                  </Link>
                </header>

                {/* Mac page title */}
                <header className="hidden md:block">
                  <h1 className="text-[2rem] font-bold tracking-tight">
                    Emergency SOS
                  </h1>
                  <p className="mt-1 text-base text-label-2">
                    One tap alerts dispatch with your location, a photo,
                    audio, and your emergency profile.
                  </p>
                </header>

                {locationPermission === "denied" && (
                  <div className="mt-3 flex items-start gap-3 rounded-2xl bg-surface p-4 md:hidden">
                    <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
                    <p className="text-sm leading-snug text-label-2">
                      <span className="font-semibold text-white">
                        Location is blocked.
                      </span>{" "}
                      Allow location for this site in your browser settings so
                      dispatch can find you.
                    </p>
                  </div>
                )}

                <div className="flex flex-1 flex-col items-center justify-center gap-10 py-6 lg:flex-row lg:gap-20">
                  <div className="flex flex-col items-center gap-7">
                    <button
                      type="button"
                      onClick={startSosCountdown}
                      className="group grid h-[min(64vmin,19rem)] w-[min(64vmin,19rem)] place-items-center rounded-full bg-[radial-gradient(circle_at_50%_28%,#f0473d,#d91f15_72%)] text-white shadow-[0_0_0_14px_rgba(229,37,27,0.16),0_0_0_30px_rgba(229,37,27,0.07),0_24px_60px_-12px_rgba(229,37,27,0.45)] transition duration-200 hover:brightness-110 active:scale-[0.97] motion-reduce:transition-none"
                      aria-label="Help. Starts a 5 second countdown, then alerts dispatch."
                    >
                      <span className="text-[clamp(2.75rem,12vmin,4.25rem)] font-bold tracking-tight drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]">
                        HELP
                      </span>
                    </button>
                    <p className="max-w-[17rem] text-center text-base leading-snug text-label-2">
                      Tap to alert dispatch. You&apos;ll have 5 seconds to
                      cancel.
                    </p>
                    <div className="lg:hidden">
                      <ReadinessChips items={readinessItems} />
                    </div>
                  </div>

                  <div className="hidden w-full max-w-sm lg:block">
                    <ReadinessCard items={readinessItems} />
                  </div>
                </div>
              </div>
            )}

            {/* ---------- Sending ---------- */}
            {uiState === "loading" && (
              <div className="flex h-full w-full animate-screen-in flex-col items-center justify-center gap-6 px-6 text-center motion-reduce:animate-none">
                <div
                  className="h-12 w-12 animate-spin rounded-full border-[3px] border-surface-2 border-t-white motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <div className="space-y-2">
                  <div role="status" aria-live="assertive">
                    <h1 className="text-[1.75rem] font-bold tracking-tight">
                      Contacting dispatch
                    </h1>
                  </div>
                  <p className="min-h-[3rem] text-base leading-snug text-label-2">
                    {LOADING_STATUSES[loadingStatusIndex]}
                  </p>
                </div>
                <p className="text-sm text-label-3">
                  Location · Photo · Audio · Medical ID
                </p>
              </div>
            )}

            {/* ---------- Fire / environmental ---------- */}
            {uiState === "fire" && (
              <CrisisScreen
                className="bg-fire"
                footer={<CancelSosButton onCancel={() => void cancelActiveSos()} />}
              >
                <TransmittingPill />
                {dispatcherMessage && (
                  <DispatcherMessageBanner message={dispatcherMessage} />
                )}
                <CrisisHeader
                  icon={<FlameIcon />}
                  title="Fire or hazard"
                  subtitle="Move toward the nearest exit if you can. Stay low under smoke."
                />
                {userProvidedContext === null ? (
                  <QuickActionMenu
                    actions={quickActionsForUiState("fire")}
                    countdown={quickActionCountdown}
                    onSelect={(selection) => void handleQuickAction(selection)}
                    surface="color"
                  />
                ) : (
                  <CrisisDispatcherStatus
                    dispatcherStatus={dispatcherStatus}
                    userProvidedContext={userProvidedContext}
                  />
                )}
              </CrisisScreen>
            )}

            {/* ---------- Medical ---------- */}
            {uiState === "medical" && (
              <CrisisScreen
                className="bg-medical"
                footer={<CancelSosButton onCancel={() => void cancelActiveSos()} />}
              >
                <TransmittingPill />
                {dispatcherMessage && (
                  <DispatcherMessageBanner message={dispatcherMessage} />
                )}
                <CrisisHeader
                  icon={<MedicalIcon />}
                  title="Medical emergency"
                  subtitle={
                    userProvidedContext === null
                      ? "Stay where you are. Dispatch is being contacted."
                      : "Breathe slowly with the circle."
                  }
                />
                {userProvidedContext !== null && (
                  <div className="mt-8 grid place-items-center" aria-hidden="true">
                    <div className="h-36 w-36 animate-breathe rounded-full bg-white/25 ring-[10px] ring-white/15 motion-reduce:animate-none" />
                  </div>
                )}
                {userProvidedContext === null ? (
                  <QuickActionMenu
                    actions={quickActionsForUiState("medical")}
                    countdown={quickActionCountdown}
                    onSelect={(selection) => void handleQuickAction(selection)}
                    surface="color"
                  />
                ) : (
                  <CrisisDispatcherStatus
                    dispatcherStatus={dispatcherStatus}
                    userProvidedContext={userProvidedContext}
                  />
                )}
              </CrisisScreen>
            )}

            {/* ---------- Threat: silent + dark ---------- */}
            {uiState === "threat" && (
              <CrisisScreen
                className="bg-black"
                footer={
                  <CancelSosButton
                    surface="discreet"
                    onCancel={() => void cancelActiveSos()}
                  />
                }
              >
                <TransmittingPill discreet />
                {dispatcherMessage && (
                  <DispatcherMessageBanner
                    discreet
                    message={dispatcherMessage}
                  />
                )}
                <CrisisHeader
                  discreet
                  icon={<ShieldIcon />}
                  title="Silent mode"
                  subtitle="Dispatch has your location. Stay quiet if you can."
                />
                {userProvidedContext === null ? (
                  <QuickActionMenu
                    actions={quickActionsForUiState("threat")}
                    countdown={quickActionCountdown}
                    onSelect={(selection) => void handleQuickAction(selection)}
                    surface="discreet"
                  />
                ) : (
                  <CrisisDispatcherStatus
                    discreet
                    dispatcherStatus={dispatcherStatus}
                    userProvidedContext={userProvidedContext}
                  />
                )}
              </CrisisScreen>
            )}

            {/* ---------- Unknown ---------- */}
            {uiState === "unknown" && (
              <CrisisScreen
                className="bg-surface"
                footer={
                  <CancelSosButton
                    surface="dark"
                    onCancel={() => void cancelActiveSos()}
                  />
                }
              >
                <TransmittingPill />
                {dispatcherMessage && (
                  <DispatcherMessageBanner message={dispatcherMessage} />
                )}
                <CrisisHeader
                  icon={<QuestionIcon />}
                  title="Dispatch is on alert"
                  subtitle="We couldn't tell what's happening. Tap what fits best."
                />
                {userProvidedContext === null ? (
                  <QuickActionMenu
                    actions={quickActionsForUiState("unknown")}
                    countdown={quickActionCountdown}
                    onSelect={(selection) => void handleQuickAction(selection)}
                    surface="dark"
                  />
                ) : (
                  <CrisisDispatcherStatus
                    dispatcherStatus={dispatcherStatus}
                    userProvidedContext={userProvidedContext}
                  />
                )}
              </CrisisScreen>
            )}

            {/* ---------- Weak connection ---------- */}
            {uiState === "low-bandwidth" && (
              <CrisisScreen
                className="bg-surface"
                footer={
                  <div className="flex w-full flex-col items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void triggerSOS()}
                      className="min-h-14 w-full max-w-sm rounded-full bg-white px-8 text-lg font-semibold text-black transition active:scale-[0.98] active:opacity-80"
                    >
                      Try Again
                    </button>
                    <CancelSosButton
                      surface="dark"
                      onCancel={() => void cancelActiveSos()}
                    />
                  </div>
                }
              >
                {dispatcherMessage && (
                  <DispatcherMessageBanner message={dispatcherMessage} />
                )}
                <CrisisHeader
                  icon={<WeakSignalIcon />}
                  title="Weak connection"
                  subtitle="Your location and a text alert were sent to dispatch. Try again to send a photo and audio."
                />
              </CrisisScreen>
            )}
          </>
        )}

        {/* ---------- Safe Walk ---------- */}
        {activeTab === "overwatch" && (
          <div className="flex h-full w-full animate-screen-in flex-col overflow-y-auto px-5 pb-5 pt-[calc(env(safe-area-inset-top)+1rem)] motion-reduce:animate-none md:px-10 md:pt-[calc(env(safe-area-inset-top)+1.5rem)]">
            <div className="mx-auto flex w-full max-w-lg flex-1 flex-col lg:mx-0 lg:max-w-5xl">
              <header className="space-y-2">
                <h1 className="text-[2.125rem] font-bold tracking-tight md:text-[2rem]">
                  Safe Walk
                </h1>
                <p className="max-w-xl text-base leading-snug text-label-2">
                  Keeps your location ready on this device while you walk.
                  Nothing is sent unless you press HELP.
                </p>
              </header>

              <div className="flex flex-1 flex-col lg:grid lg:grid-cols-2 lg:items-center lg:gap-16">
                <div className="flex flex-1 items-center justify-center py-8">
                  {!isSafeWalkArmed ? (
                    <div className="grid h-56 w-56 place-items-center rounded-full border-2 border-dashed border-separator lg:h-72 lg:w-72">
                      <div className="flex flex-col items-center gap-2 text-label-3">
                        <LocationIcon className="h-8 w-8" />
                        <p className="text-base font-semibold">Off</p>
                      </div>
                    </div>
                  ) : (
                    <div className="relative grid h-56 w-56 place-items-center overflow-hidden rounded-full border border-safe/40 bg-black lg:h-72 lg:w-72">
                      <div
                        className="absolute inset-0 animate-ping rounded-full border border-safe/30 [animation-duration:2.5s] motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      <div className="absolute inset-[12%] rounded-full border border-safe/20" aria-hidden="true" />
                      <div className="absolute inset-[28%] rounded-full border border-safe/25" aria-hidden="true" />
                      <div
                        className="absolute inset-0 animate-spin rounded-full [animation-duration:3s] motion-reduce:animate-none"
                        style={{
                          background:
                            "conic-gradient(from 0deg, transparent 0deg, rgba(48,209,88,0.35) 45deg, transparent 90deg)",
                        }}
                        aria-hidden="true"
                      />
                      <div className="relative z-10 flex flex-col items-center gap-2 text-safe">
                        <LocationIcon className="h-8 w-8" />
                        <p className="text-base font-semibold">On</p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="divide-y divide-separator overflow-hidden rounded-2xl bg-surface ring-1 ring-white/5">
                    <div className="flex min-h-12 items-center justify-between px-4 py-3">
                      <span className="text-base">Status</span>
                      <span
                        role="status"
                        className={`text-base font-semibold ${
                          isSafeWalkArmed ? "text-safe" : "text-label-3"
                        }`}
                      >
                        {isSafeWalkArmed ? "Watching location" : "Off"}
                      </span>
                    </div>
                    <div className="flex min-h-12 items-center justify-between px-4 py-3">
                      <span className="text-base">Latitude</span>
                      <span className="text-base tabular-nums text-label-2">
                        {!isSafeWalkArmed
                          ? "—"
                          : liveGps
                            ? liveGps.lat.toFixed(5)
                            : "Finding…"}
                      </span>
                    </div>
                    <div className="flex min-h-12 items-center justify-between px-4 py-3">
                      <span className="text-base">Longitude</span>
                      <span className="text-base tabular-nums text-label-2">
                        {!isSafeWalkArmed
                          ? "—"
                          : liveGps
                            ? liveGps.lng.toFixed(5)
                            : "Finding…"}
                      </span>
                    </div>
                  </div>

                  {!isSafeWalkArmed ? (
                    <button
                      type="button"
                      onClick={() => setIsSafeWalkArmed(true)}
                      className="min-h-[3.25rem] w-full rounded-2xl bg-safe px-6 text-lg font-semibold text-black transition hover:brightness-110 active:scale-[0.98] active:opacity-80"
                    >
                      Start Safe Walk
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setIsSafeWalkArmed(false);
                        setLiveGps(null);
                      }}
                      className="min-h-[3.25rem] w-full rounded-2xl bg-surface-2 px-6 text-lg font-semibold text-white transition hover:bg-separator active:scale-[0.98] active:opacity-80"
                    >
                      Stop Safe Walk
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Demo simulator — dev builds only, visible across both tabs */}
      {process.env.NODE_ENV !== "production" && (
        <div className="relative z-50 flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-dashed border-separator bg-black px-3 py-1">
          {(
            [
              ["Fire", "fire"],
              ["Medical", "medical"],
              ["Threat", "threat"],
              ["Unknown", "unknown"],
            ] as const
          ).map(([label, state]) => (
            <button
              key={state}
              type="button"
              onClick={() => {
                ensureSessionForSim();
                setActiveTab("sos");
                setUiState(state);
              }}
              className="rounded px-2 py-1 text-xs text-label-3 hover:text-white"
            >
              [Sim {label}]
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              clearTelemetryInterval();
              setActiveTab("sos");
              setUiState("low-bandwidth");
            }}
            className="rounded px-2 py-1 text-xs text-label-3 hover:text-white"
          >
            [Sim Bad Wi-Fi]
          </button>
          <button
            type="button"
            onClick={resetSession}
            className="rounded px-2 py-1 text-xs text-label-3 hover:text-white"
          >
            [Reset]
          </button>
        </div>
      )}

      <AppTabBar activeTab={activeTab} onSelect={setActiveTab} />
      </div>
    </main>
  );
}

function SosFallback() {
  return (
    <main className="flex h-dvh w-screen items-center justify-center overflow-hidden bg-black text-white">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-[3px] border-surface-2 border-t-white motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-base text-label-2">Loading…</p>
      </div>
    </main>
  );
}

export default function SosPage() {
  return (
    <Suspense fallback={<SosFallback />}>
      <SosPageContent />
    </Suspense>
  );
}
