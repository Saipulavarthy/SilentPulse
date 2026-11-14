"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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

type SosPayload = {
  image: string;
  audio: string;
  gps: { lat: number; lng: number } | null;
  iceProfile: IceProfile | null;
};

const ICE_STORAGE_KEY = "silentpulse_ice_profile";

function readIceProfile(): IceProfile | null {
  try {
    const savedProfile = localStorage.getItem(ICE_STORAGE_KEY);
    if (!savedProfile) return null;
    return JSON.parse(savedProfile) as IceProfile;
  } catch (error) {
    console.error("Failed to parse ICE profile:", error);
    return null;
  }
}

function crisisTypeToUiState(crisisType: string): UiState {
  switch (crisisType) {
    case "ENVIRONMENTAL_HAZARD":
      return "fire";
    case "MEDICAL_CRISIS":
      return "medical";
    case "ACTIVE_THREAT":
      return "threat";
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

function getGpsCoordinates(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
}

function recordAudioBase64(
  stream: MediaStream,
  durationMs = 3000,
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

function SosPageContent() {
  const [uiState, setUiState] = useState<UiState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("sos");
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [liveGps, setLiveGps] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const autoTriggeredRef = useRef(false);
  const sosInFlightRef = useRef(false);
  const watchIdRef = useRef<number | null>(null);

  const triggerSOS = useCallback(async () => {
    if (sosInFlightRef.current) return;
    sosInFlightRef.current = true;

    // Immediate UI feedback before any async hardware work
    setActiveTab("sos");
    setUiState("loading");

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

      // Ensure at least one decoded frame is available
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

      // Record ambient audio for exactly 3 seconds while stream is live
      const [audio, gps] = await Promise.all([
        recordAudioBase64(stream, 3000),
        gpsPromise,
      ]);

      // Stop camera + mic immediately after capture to save battery
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;

      const iceProfile = readIceProfile();

      const payload: SosPayload = {
        image,
        audio,
        gps,
        iceProfile,
      };

      console.log("SOS Payload:", payload);

      // Mock backend — real fetch comes later
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const mockResponse = { crisisType: "MEDICAL_CRISIS" as const };
      setUiState(crisisTypeToUiState(mockResponse.crisisType));
    } catch (error) {
      console.error("SOS trigger failed:", error);
      setUiState("low-bandwidth");
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      sosInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (searchParams.get("auto") === "true" && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true;
      void triggerSOS();
    }
  }, [searchParams, triggerSOS]);

  // Live GPS readout while Safe Walk / Overwatch is armed
  useEffect(() => {
    if (!isMonitoring) {
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
  }, [isMonitoring]);

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
              <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-zinc-900">
                <div
                  className="h-16 w-16 animate-spin rounded-full border-4 border-zinc-600 border-t-white"
                  aria-hidden
                />
                <p className="text-lg font-medium tracking-wide text-zinc-200">
                  Analyzing Context...
                </p>
              </div>
            )}

            {uiState === "fire" && (
              <div className="flex h-full w-full items-center justify-center bg-orange-600 px-8 text-center">
                <p className="text-2xl font-bold leading-tight tracking-wide text-white sm:text-4xl">
                  ENVIRONMENTAL HAZARD DETECTED. PROCEED TO EXITS.
                </p>
              </div>
            )}

            {uiState === "medical" && (
              <div className="flex h-full w-full flex-col items-center justify-center gap-10 bg-blue-600 px-8 text-center">
                <div
                  className="h-48 w-48 animate-pulse rounded-full bg-blue-300/40 ring-8 ring-white/30 sm:h-64 sm:w-64"
                  aria-hidden
                />
                <p className="text-xl font-bold leading-tight tracking-wide text-white sm:text-3xl">
                  MEDICAL CRISIS. HELP IS ON THE WAY. BREATHE WITH THE CIRCLE.
                </p>
              </div>
            )}

            {uiState === "threat" && (
              <div className="flex h-full w-full items-center justify-center bg-black px-8 text-center">
                <p className="text-sm font-medium tracking-wide text-zinc-500 sm:text-base">
                  THREAT DETECTED. SCREEN DARKENED FOR SAFETY. SOS SENT.
                </p>
              </div>
            )}

            {uiState === "low-bandwidth" && (
              <div className="flex h-full w-full items-center justify-center bg-zinc-700 px-8 text-center">
                <p className="text-lg font-semibold tracking-wide text-zinc-200 sm:text-2xl">
                  POOR CONNECTION. TEXT AND GPS DISPATCHED.
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

            <div className="relative flex flex-1 items-center justify-center py-6">
              {isMonitoring ? (
                <div className="relative flex h-56 w-56 items-center justify-center">
                  <div className="absolute inset-0 animate-ping rounded-full border border-emerald-500/40" />
                  <div className="absolute inset-4 animate-pulse rounded-full border border-emerald-400/50" />
                  <div className="absolute inset-10 animate-pulse rounded-full bg-emerald-500/20" />
                  <div className="relative z-10 h-4 w-4 rounded-full bg-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.9)]" />
                </div>
              ) : (
                <div className="flex h-56 w-56 items-center justify-center rounded-full border border-dashed border-zinc-700">
                  <p className="px-6 text-center text-sm text-zinc-600">
                    Radar idle. Arm Safe Walk to begin monitoring.
                  </p>
                </div>
              )}
            </div>

            <div className="w-full max-w-md space-y-4">
              {isMonitoring && (
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

              {!isMonitoring ? (
                <button
                  type="button"
                  onClick={() => setIsMonitoring(true)}
                  className="w-full rounded-2xl bg-emerald-600 px-4 py-4 text-lg font-bold tracking-wide text-white transition hover:bg-emerald-500 active:scale-[0.98]"
                >
                  Arm Safe Walk
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setIsMonitoring(false);
                    setLiveGps(null);
                  }}
                  className="w-full rounded-2xl bg-red-600 px-4 py-4 text-lg font-bold tracking-wide text-white transition hover:bg-red-500 active:scale-[0.98]"
                >
                  Disarm
                </button>
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
            setActiveTab("sos");
            setUiState("low-bandwidth");
          }}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Bad Wi-Fi]
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab("sos");
            setUiState("idle");
          }}
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
