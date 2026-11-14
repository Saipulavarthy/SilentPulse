"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type UiState =
  | "idle"
  | "loading"
  | "fire"
  | "medical"
  | "threat"
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

/** UMass Amherst fallback for local testing when GPS is denied/unavailable */
const FALLBACK_GPS: GpsCoords = {
  lat: 42.3868,
  lng: -72.5301,
};

const LOADING_STATUSES = [
  "SILENT OVERWATCH ARMED",
  "Capturing environmental audio & visual telemetry...",
  "Transmitting to AI Dispatcher...",
] as const;

const ACTIVE_CRISIS_STATES: UiState[] = ["fire", "medical", "threat"];
const TELEMETRY_INTERVAL_MS = 30_000;

function crisisTypeToUiState(crisisType: string): UiState {
  switch (crisisType) {
    case "ENVIRONMENTAL_HAZARD":
      return "fire";
    case "MEDICAL_CRISIS":
      return "medical";
    case "ACTIVE_THREAT":
      return "threat";
    case "UNKNOWN":
      return "low-bandwidth";
    default:
      return "low-bandwidth";
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

function getGpsCoordinates(timeoutMs = 5000): Promise<GpsCoords> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn("Geolocation unavailable — using UMass Amherst fallback GPS");
      resolve(FALLBACK_GPS);
      return;
    }

    let settled = false;

    const finish = (coords: GpsCoords, usedFallback: boolean) => {
      if (settled) return;
      settled = true;
      if (usedFallback) {
        console.warn(
          "GPS failed, timed out, or denied — using UMass Amherst fallback GPS",
          coords,
        );
      }
      resolve(coords);
    };

    const timer = window.setTimeout(() => {
      finish(FALLBACK_GPS, true);
    }, timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer);
        finish(
          {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
          false,
        );
      },
      () => {
        window.clearTimeout(timer);
        finish(FALLBACK_GPS, true);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
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

function LiveTelemetryBadge({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <div
      className={`absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] backdrop-blur ${
        tone === "dark"
          ? "bg-zinc-900/80 text-zinc-400"
          : "bg-black/35 text-white"
      }`}
    >
      <span
        className="h-2 w-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
        aria-hidden
      />
      Transmitting Live Telemetry...
    </div>
  );
}

function CrisisDispatcherStatus({
  dispatcherStatus,
  tone = "light",
}: {
  dispatcherStatus: "reviewing" | "dispatched";
  tone?: "light" | "dark";
}) {
  if (dispatcherStatus === "dispatched") {
    return (
      <p
        className={`mt-6 text-2xl font-black leading-tight tracking-wide sm:text-4xl ${
          tone === "dark" ? "text-emerald-400" : "text-white"
        }`}
      >
        HELP IS ON THE WAY. FIRST RESPONDERS DISPATCHED.
      </p>
    );
  }

  return (
    <div
      className={`mt-6 flex items-center justify-center gap-3 ${
        tone === "dark" ? "text-zinc-400" : "text-white/90"
      }`}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]"
        aria-hidden
      />
      <p className="text-sm font-medium leading-snug tracking-wide sm:text-base">
        Live Telemetry Connected. Dispatcher is reviewing your situation.
      </p>
    </div>
  );
}

function SosPageContent() {
  const [uiState, setUiState] = useState<UiState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("sos");
  const [isSafeWalkArmed, setIsSafeWalkArmed] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dispatcherStatus, setDispatcherStatus] = useState<
    "reviewing" | "dispatched"
  >("reviewing");
  const [loadingStatusIndex, setLoadingStatusIndex] = useState(0);
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
  const sessionIdRef = useRef<string | null>(null);

  const clearTelemetryInterval = useCallback(() => {
    if (telemetryIntervalRef.current !== null) {
      window.clearInterval(telemetryIntervalRef.current);
      telemetryIntervalRef.current = null;
    }
  }, []);

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
          dispatcherStatus?: "reviewing" | "dispatched";
        };
        if (!data.crisisType) {
          throw new Error("Triage API returned no crisisType");
        }

        if (data.dispatcherStatus === "dispatched") {
          setDispatcherStatus("dispatched");
        }

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
    [],
  );

  const triggerSOS = useCallback(async () => {
    if (sosInFlightRef.current) return;

    const newSessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Date.now().toString();

    sessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
    setDispatcherStatus("reviewing");
    setActiveTab("sos");
    setUiState("loading");

    await captureAndSendTelemetry(newSessionId, { updateUi: true });
  }, [captureAndSendTelemetry]);

  const resetSession = useCallback(() => {
    clearTelemetryInterval();
    sessionIdRef.current = null;
    setSessionId(null);
    setDispatcherStatus("reviewing");
    setActiveTab("sos");
    setUiState("idle");
  }, [clearTelemetryInterval]);

  // Apple Lock Screen shortcut: /sos?auto=true bypasses the HELP tap
  useEffect(() => {
    if (searchParams.get("auto") === "true" && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      void triggerSOS();
    }
  }, [searchParams, triggerSOS]);

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
    if (sessionIdRef.current) return;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Date.now().toString();
    sessionIdRef.current = id;
    setSessionId(id);
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-900 text-white">
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

      {/* ICE profile settings — idle only so it never distracts during a crisis */}
      {uiState === "idle" && (
        <Link
          href="/?edit=true"
          className="absolute top-6 right-6 z-40 rounded-full p-2 text-gray-400 transition hover:bg-zinc-800 hover:text-white"
          aria-label="Edit ICE medical profile"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
            aria-hidden
          >
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </Link>
      )}

      {/* Main content — leave room for sim row + bottom tabs */}
      <div className="h-[calc(100%-7.5rem)] w-full overflow-hidden">
        {activeTab === "sos" && (
          <>
            {uiState === "idle" && (
              <div className="flex h-full w-full items-center justify-center">
                <button
                  type="button"
                  onClick={() => void triggerSOS()}
                  className="flex h-[65vmin] w-[65vmin] max-h-[400px] max-w-[400px] items-center justify-center rounded-full bg-red-600 text-4xl font-black tracking-widest text-white shadow-[0_0_60px_rgba(220,38,38,0.55)] animate-pulse transition active:scale-95 sm:text-6xl"
                  aria-label="Send SOS help signal"
                >
                  HELP
                </button>
              </div>
            )}

            {uiState === "loading" && (
              <div className="flex h-full w-full flex-col items-center justify-center gap-8 bg-black px-6">
                <div className="flex items-center gap-3">
                  <span
                    className="h-3 w-3 animate-pulse rounded-full bg-red-600 shadow-[0_0_12px_rgba(220,38,38,0.9)]"
                    aria-hidden
                  />
                  <p className="font-mono text-xs font-semibold uppercase tracking-[0.35em] text-red-500">
                    REC · Live Telemetry
                  </p>
                </div>

                <div
                  className="flex h-16 items-end justify-center gap-1.5"
                  aria-hidden
                >
                  <span className="w-2 animate-bounce rounded-full bg-red-500 [animation-delay:0ms] h-6" />
                  <span className="w-2 animate-bounce rounded-full bg-red-400 [animation-delay:100ms] h-10" />
                  <span className="w-2 animate-bounce rounded-full bg-red-500 [animation-delay:200ms] h-14" />
                  <span className="w-2 animate-bounce rounded-full bg-red-400 [animation-delay:300ms] h-8" />
                  <span className="w-2 animate-bounce rounded-full bg-red-500 [animation-delay:150ms] h-12" />
                </div>

                <div className="max-w-sm space-y-3 text-center">
                  <p className="text-xl font-black tracking-[0.2em] text-white sm:text-2xl">
                    SILENT OVERWATCH ARMED
                  </p>
                  <p className="min-h-[2.5rem] font-mono text-sm leading-relaxed text-zinc-300 transition-opacity">
                    {LOADING_STATUSES[loadingStatusIndex]}
                  </p>
                  <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-600">
                    Audio · Visual · GPS · ICE Profile
                  </p>
                </div>
              </div>
            )}

            {uiState === "fire" && (
              <div className="relative flex h-full w-full flex-col items-center justify-center bg-orange-600 px-8 text-center">
                <LiveTelemetryBadge />
                <p className="text-2xl font-bold leading-tight tracking-wide text-white sm:text-4xl">
                  ENVIRONMENTAL HAZARD DETECTED. PROCEED TO EXITS.
                </p>
                <CrisisDispatcherStatus dispatcherStatus={dispatcherStatus} />
              </div>
            )}

            {uiState === "medical" && (
              <div className="relative flex h-full w-full flex-col items-center justify-center gap-6 bg-blue-600 px-8 text-center">
                <LiveTelemetryBadge />
                <div
                  className="h-48 w-48 animate-pulse rounded-full bg-blue-300/40 ring-8 ring-white/30 sm:h-64 sm:w-64"
                  aria-hidden
                />
                <p className="text-xl font-bold leading-tight tracking-wide text-white sm:text-3xl">
                  MEDICAL CRISIS. BREATHE WITH THE CIRCLE.
                </p>
                <CrisisDispatcherStatus dispatcherStatus={dispatcherStatus} />
              </div>
            )}

            {uiState === "threat" && (
              <div className="relative flex h-full w-full flex-col items-center justify-center bg-black px-8 text-center">
                <LiveTelemetryBadge tone="dark" />
                <p className="text-sm font-medium tracking-wide text-zinc-500 sm:text-base">
                  THREAT DETECTED. SCREEN DARKENED FOR SAFETY.
                </p>
                <CrisisDispatcherStatus
                  dispatcherStatus={dispatcherStatus}
                  tone="dark"
                />
              </div>
            )}

            {uiState === "low-bandwidth" && (
              <div className="flex h-full w-full items-center justify-center bg-zinc-700 px-8 text-center">
                <p className="text-lg font-semibold tracking-wide text-zinc-200 sm:text-2xl">
                  POOR CONNECTION. TEXT AND GPS SENT TO DISPATCH.
                </p>
              </div>
            )}
          </>
        )}

        {activeTab === "overwatch" && (
          <div className="flex h-full w-full flex-col items-center justify-between bg-zinc-950 px-6 py-8">
            <div className="w-full max-w-md space-y-2 text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-emerald-500">
                Active Overwatch
              </p>
              <h2 className="text-2xl font-bold tracking-tight text-white">
                Safe Walk Mode
              </h2>
              <p className="text-sm text-zinc-500">
                Local sensor buffer for walking alone. Nothing leaves the device
                until you trigger SOS.
              </p>
            </div>

            <div className="relative flex flex-1 flex-col items-center justify-center gap-4 py-6">
              {!isSafeWalkArmed ? (
                <div className="flex h-64 w-64 flex-col items-center justify-center rounded-full border border-dashed border-zinc-700 px-6 text-center">
                  <p className="text-sm text-zinc-600">
                    Radar idle. Arm Safe Walk to begin monitoring.
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsSafeWalkArmed(true)}
                    className="mt-4 rounded-full bg-emerald-600 px-6 py-2 font-bold text-white transition-all hover:bg-emerald-500"
                  >
                    Arm Safe Walk
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div className="relative flex h-56 w-56 items-center justify-center overflow-hidden rounded-full border border-emerald-500/50 bg-zinc-950 shadow-[0_0_40px_rgba(16,185,129,0.25)]">
                    {/* Sonar ping ring */}
                    <div
                      className="absolute inset-0 animate-ping rounded-full border border-emerald-500/40"
                      aria-hidden
                    />
                    {/* Concentric range rings */}
                    <div
                      className="absolute inset-3 rounded-full border border-emerald-500/20"
                      aria-hidden
                    />
                    <div
                      className="absolute inset-8 rounded-full border border-emerald-500/30"
                      aria-hidden
                    />
                    <div
                      className="absolute inset-14 rounded-full border border-emerald-400/40"
                      aria-hidden
                    />
                    {/* Sweeping radar beam */}
                    <div
                      className="absolute inset-0 animate-spin rounded-full opacity-70"
                      style={{
                        background:
                          "conic-gradient(from 0deg, transparent 0deg, rgba(16,185,129,0.55) 50deg, transparent 90deg)",
                      }}
                      aria-hidden
                    />
                    {/* Center crosshair + status */}
                    <div className="relative z-10 flex max-w-[9rem] flex-col items-center gap-2 px-3 text-center">
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,1)]" />
                      <p className="text-[11px] font-semibold leading-snug text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]">
                        Buffer Active: Overwriting every 30s
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setIsSafeWalkArmed(false);
                      setLiveGps(null);
                    }}
                    className="mt-4 text-gray-400 underline transition-all hover:text-white"
                  >
                    Disarm
                  </button>
                </div>
              )}
            </div>

            <div className="w-full max-w-md space-y-4">
              {isSafeWalkArmed && (
                <div className="space-y-3 rounded-2xl border border-emerald-500/20 bg-zinc-900/80 p-4">
                  <p className="text-center text-sm font-medium text-emerald-400">
                    Sensors Armed. Audio and location are being locally
                    buffered.
                  </p>
                  <div className="grid grid-cols-2 gap-3 font-mono text-xs text-zinc-300">
                    <div className="rounded-xl bg-zinc-950 px-3 py-2">
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                        Latitude
                      </p>
                      <p>
                        {liveGps ? liveGps.lat.toFixed(6) : "Acquiring..."}
                      </p>
                    </div>
                    <div className="rounded-xl bg-zinc-950 px-3 py-2">
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                        Longitude
                      </p>
                      <p>
                        {liveGps ? liveGps.lng.toFixed(6) : "Acquiring..."}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Demo simulator — visible across both tabs */}
      <div className="absolute bottom-[4.25rem] left-0 right-0 z-50 flex flex-wrap items-center justify-center gap-2 px-3">
        <button
          type="button"
          onClick={() => {
            ensureSessionForSim();
            setActiveTab("sos");
            setUiState("fire");
          }}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Fire]
        </button>
        <button
          type="button"
          onClick={() => {
            ensureSessionForSim();
            setActiveTab("sos");
            setUiState("medical");
          }}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Medical]
        </button>
        <button
          type="button"
          onClick={() => {
            ensureSessionForSim();
            setActiveTab("sos");
            setUiState("threat");
          }}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Threat]
        </button>
        <button
          type="button"
          onClick={() => {
            clearTelemetryInterval();
            setActiveTab("sos");
            setUiState("low-bandwidth");
          }}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Bad Wi-Fi]
        </button>
        <button
          type="button"
          onClick={resetSession}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Reset]
        </button>
      </div>

      {/* Bottom navigation */}
      <nav className="absolute bottom-0 left-0 right-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto grid h-16 max-w-lg grid-cols-2">
          <button
            type="button"
            onClick={() => setActiveTab("sos")}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-semibold tracking-wide transition ${
              activeTab === "sos"
                ? "bg-zinc-900 text-red-500"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <span className="text-base leading-none">●</span>
            SOS
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("overwatch")}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-semibold tracking-wide transition ${
              activeTab === "overwatch"
                ? "bg-zinc-900 text-emerald-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <span className="text-base leading-none">◎</span>
            Overwatch
          </button>
        </div>
      </nav>
    </main>
  );
}

function SosFallback() {
  return (
    <main className="flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-900 text-white">
      <div className="flex flex-col items-center gap-6">
        <div
          className="h-16 w-16 animate-spin rounded-full border-4 border-zinc-600 border-t-white"
          aria-hidden
        />
        <p className="text-lg font-medium tracking-wide text-zinc-200">
          Analyzing Context...
        </p>
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
