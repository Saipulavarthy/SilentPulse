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

type SosPayload = {
  image: string;
  audio: string;
  gps: { lat: number; lng: number } | null;
  userId: string;
};

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
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const autoTriggeredRef = useRef(false);
  const sosInFlightRef = useRef(false);

  const triggerSOS = useCallback(async () => {
    if (sosInFlightRef.current) return;
    sosInFlightRef.current = true;

    // Immediate UI feedback before any async hardware work
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

      const payload: SosPayload = {
        image,
        audio,
        gps,
        userId: "user_123",
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

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-900 text-white">
      {/* Hidden capture surfaces for getUserMedia → canvas snapshot */}
      <video ref={videoRef} className="pointer-events-none absolute h-0 w-0 opacity-0" playsInline muted />
      <canvas ref={canvasRef} className="pointer-events-none absolute h-0 w-0 opacity-0" />

      {uiState === "idle" && (
        <div className="flex h-full w-full items-center justify-center">
          <button
            type="button"
            onClick={() => void triggerSOS()}
            className="flex h-[70vmin] w-[70vmin] max-h-[420px] max-w-[420px] items-center justify-center rounded-full bg-red-600 text-4xl font-black tracking-widest text-white shadow-[0_0_60px_rgba(220,38,38,0.55)] animate-pulse transition active:scale-95 sm:text-6xl"
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

      {/* Demo simulator — keep semi-transparent for live demos */}
      <div className="absolute bottom-4 left-0 right-0 z-50 flex flex-wrap items-center justify-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setUiState("fire")}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Fire]
        </button>
        <button
          type="button"
          onClick={() => setUiState("medical")}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Medical]
        </button>
        <button
          type="button"
          onClick={() => setUiState("threat")}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Threat]
        </button>
        <button
          type="button"
          onClick={() => setUiState("low-bandwidth")}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Sim Bad Wi-Fi]
        </button>
        <button
          type="button"
          onClick={() => setUiState("idle")}
          className="rounded px-2 py-1 text-xs text-white opacity-30 hover:opacity-70"
        >
          [Reset]
        </button>
      </div>
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
