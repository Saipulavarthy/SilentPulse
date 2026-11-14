"use client";

import {
  type FormEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppMark } from "@/components/AppMark";

const ICE_STORAGE_KEY = "silentpulse_ice_profile";
const LOCATION_PERMISSION_KEY = "silentpulse_location_permission";
const MEDIA_PERMISSION_KEY = "silentpulse_media_permission";

type MediaPermissionState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unavailable"
  | "unsupported";

/**
 * Asks for camera + mic up front so the system prompt never appears for the
 * first time mid-emergency. Tracks are stopped immediately — nothing is recorded.
 */
async function requestMediaPermission(): Promise<MediaPermissionState> {
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    return "unavailable";
  }
}

const BLOOD_TYPES = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
  "Unknown",
] as const;

type BloodType = (typeof BLOOD_TYPES)[number];

type IceProfile = {
  fullName: string;
  age: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  bloodType: BloodType;
  medicalConditions: string;
  allergies: string;
  mobilityNotes: string;
  sensoryNotes: string;
};

function isBloodType(value: string): value is BloodType {
  return (BLOOD_TYPES as readonly string[]).includes(value);
}

type LocationPermissionState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unavailable"
  | "unsupported";

type LocationRequestResult = {
  state: LocationPermissionState;
  coords?: { lat: number; lng: number };
  detail?: string;
};

function readPositionOnce(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function requestLocationPermission(): Promise<LocationRequestResult> {
  if (!navigator.geolocation) {
    return {
      state: "unsupported",
      detail: "This browser can't share your location.",
    };
  }

  try {
    // 1) Fast network/Wi-Fi estimate (best on laptops)
    const position = await readPositionOnce({
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 60000,
    });
    return {
      state: "granted",
      coords: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      },
      detail: "Allowed",
    };
  } catch (firstError) {
    const err = firstError as GeolocationPositionError;
    console.warn("Location attempt 1 failed:", {
      code: err?.code,
      message: err?.message,
    });

    if (err?.code === err?.PERMISSION_DENIED) {
      return {
        state: "denied",
        detail:
          "Location is blocked. Allow it for this site in your browser settings, then try again.",
      };
    }

    // 2) One more try with a longer window (sometimes Wi-Fi triangulation is slow)
    try {
      const retry = await readPositionOnce({
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 0,
      });
      return {
        state: "granted",
        coords: {
          lat: retry.coords.latitude,
          lng: retry.coords.longitude,
        },
        detail: "Allowed",
      };
    } catch (secondError) {
      console.warn("Location attempt 2 failed:", secondError);
      // Permission is fine — device just has no fix (very common on Macs indoors).
      // SOS still works with the UMass campus fallback coordinates.
      return {
        state: "unavailable",
        detail:
          "Allowed. No GPS fix yet — SOS will use your campus location until one is found.",
      };
    }
  }
}

/* iOS-style grouped form pieces ------------------------------------ */

const fieldClassName =
  "mt-1 w-full bg-transparent text-base text-white outline-none placeholder:text-label-3";

function FormSection({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="px-4 text-sm font-medium text-label-2">{title}</h2>
      <div className="divide-y divide-separator overflow-hidden rounded-2xl bg-surface ring-1 ring-white/5">
        {children}
      </div>
      {footer && (
        <p className="px-4 text-sm leading-snug text-label-3">{footer}</p>
      )}
    </section>
  );
}

function FieldRow({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block px-4 py-3 transition-colors focus-within:bg-surface-2">
      <span className="text-sm text-label-2">
        {label}
        {required && <span className="sr-only"> (required)</span>}
      </span>
      {children}
    </label>
  );
}

function PermissionRow({
  title,
  description,
  status,
  statusTone,
  actionLabel,
  onAction,
  disabled,
  icon,
}: {
  title: string;
  description: string;
  status: string | null;
  statusTone: "ok" | "warn" | "info";
  actionLabel: string | null;
  onAction: () => void;
  disabled: boolean;
  icon: ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 py-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-tint">
        {icon}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-base font-semibold text-white">{title}</p>
        <p className="text-sm leading-snug text-label-2">{description}</p>
        {status && (
          <p
            role="status"
            className={`flex items-start gap-1.5 pt-1 text-sm font-medium ${
              statusTone === "ok"
                ? "text-safe"
                : statusTone === "warn"
                  ? "text-warn"
                  : "text-label-2"
            }`}
          >
            {statusTone === "ok" && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            )}
            <span>{status}</span>
          </p>
        )}
        {actionLabel && (
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className="mt-2 min-h-11 rounded-full bg-tint-fill px-5 text-sm font-semibold text-white transition active:opacity-70 disabled:opacity-50"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function OnboardingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEditing = searchParams.get("edit") === "true";
  const [checkingProfile, setCheckingProfile] = useState(true);
  const [fullName, setFullName] = useState("");
  const [age, setAge] = useState("");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const [bloodType, setBloodType] = useState<BloodType>("Unknown");
  const [medicalConditions, setMedicalConditions] = useState("");
  const [allergies, setAllergies] = useState("");
  const [mobilityNotes, setMobilityNotes] = useState("");
  const [sensoryNotes, setSensoryNotes] = useState("");
  const [locationPermission, setLocationPermission] =
    useState<LocationPermissionState>("idle");
  const [locationDetail, setLocationDetail] = useState<string>("");
  const [lastCoords, setLastCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mediaPermission, setMediaPermission] =
    useState<MediaPermissionState>("idle");

  useEffect(() => {
    try {
      const savedMedia = localStorage.getItem(MEDIA_PERMISSION_KEY);
      if (
        savedMedia === "granted" ||
        savedMedia === "denied" ||
        savedMedia === "unavailable" ||
        savedMedia === "unsupported"
      ) {
        setMediaPermission(savedMedia);
      }

      const savedPermission = localStorage.getItem(LOCATION_PERMISSION_KEY);
      if (
        savedPermission === "granted" ||
        savedPermission === "denied" ||
        savedPermission === "unavailable" ||
        savedPermission === "unsupported"
      ) {
        setLocationPermission(savedPermission);
      }

      const existing = localStorage.getItem(ICE_STORAGE_KEY);
      if (existing && !isEditing) {
        router.replace("/sos");
        return;
      }

      if (existing && isEditing) {
        const profile = JSON.parse(existing) as Partial<IceProfile>;
        setFullName(profile.fullName ?? "");
        setAge(profile.age ?? "");
        setEmergencyContactName(profile.emergencyContactName ?? "");
        setEmergencyContactPhone(profile.emergencyContactPhone ?? "");
        setBloodType(
          profile.bloodType && isBloodType(profile.bloodType)
            ? profile.bloodType
            : "Unknown",
        );
        setMedicalConditions(profile.medicalConditions ?? "");
        setAllergies(profile.allergies ?? "");
        setMobilityNotes(profile.mobilityNotes ?? "");
        setSensoryNotes(profile.sensoryNotes ?? "");
      }
    } catch (error) {
      console.error("Failed to read ICE profile:", error);
    }
    setCheckingProfile(false);
  }, [router, isEditing]);

  async function handleEnableLocation() {
    setLocationPermission("requesting");
    setLocationDetail("Waiting for your answer…");
    const result = await requestLocationPermission();
    setLocationPermission(result.state);
    setLocationDetail(result.detail ?? "");
    if (result.coords) setLastCoords(result.coords);
    // Persist "granted" for both true GPS fix and permission-ok-but-no-fix
    const stored =
      result.state === "unavailable" ? "granted" : result.state;
    localStorage.setItem(LOCATION_PERMISSION_KEY, stored);
  }

  async function handleEnableMedia() {
    setMediaPermission("requesting");
    const result = await requestMediaPermission();
    setMediaPermission(result);
    try {
      localStorage.setItem(MEDIA_PERMISSION_KEY, result);
    } catch {
      /* ignore */
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    const profile: IceProfile = {
      fullName: fullName.trim(),
      age: age.trim(),
      emergencyContactName: emergencyContactName.trim(),
      emergencyContactPhone: emergencyContactPhone.trim(),
      bloodType,
      medicalConditions: medicalConditions.trim(),
      allergies: allergies.trim(),
      mobilityNotes: mobilityNotes.trim(),
      sensoryNotes: sensoryNotes.trim(),
    };

    localStorage.setItem(ICE_STORAGE_KEY, JSON.stringify(profile));

    // Ensure the browser location prompt happens during setup if not already granted
    if (locationPermission !== "granted" && locationPermission !== "unavailable") {
      const result = await requestLocationPermission();
      setLocationPermission(result.state);
      setLocationDetail(result.detail ?? "");
      if (result.coords) setLastCoords(result.coords);
      const stored =
        result.state === "unavailable" ? "granted" : result.state;
      localStorage.setItem(LOCATION_PERMISSION_KEY, stored);
    }

    setIsSubmitting(false);
    router.push("/sos");
  }

  if (checkingProfile) {
    return (
      <main className="flex min-h-dvh w-screen items-center justify-center bg-black text-label-2">
        <p className="text-base">Loading…</p>
      </main>
    );
  }

  const locationStatus: { text: string | null; tone: "ok" | "warn" | "info" } =
    locationPermission === "granted"
      ? {
          text: lastCoords
            ? `Allowed · ${lastCoords.lat.toFixed(4)}, ${lastCoords.lng.toFixed(4)}`
            : "Allowed",
          tone: "ok",
        }
      : locationPermission === "unavailable"
        ? {
            text:
              locationDetail ||
              "Allowed. No GPS fix yet — SOS will use your campus location until one is found.",
            tone: "ok",
          }
        : locationPermission === "denied"
          ? {
              text:
                locationDetail ||
                "Location is blocked. Allow it for this site in your browser settings, then try again.",
              tone: "warn",
            }
          : locationPermission === "unsupported"
            ? { text: "This browser can't share your location.", tone: "warn" }
            : locationPermission === "requesting"
              ? { text: locationDetail || "Waiting for your answer…", tone: "info" }
              : { text: null, tone: "info" };

  const mediaStatus: { text: string | null; tone: "ok" | "warn" | "info" } =
    mediaPermission === "granted"
      ? { text: "Allowed", tone: "ok" }
      : mediaPermission === "denied"
        ? {
            text: "Blocked. Allow the camera and microphone for this site in your browser settings, then try again.",
            tone: "warn",
          }
        : mediaPermission === "unavailable"
          ? {
              text: "No camera or microphone found. SOS will still send your location.",
              tone: "warn",
            }
          : mediaPermission === "unsupported"
            ? {
                text: "This browser can't use the camera or microphone. SOS will still send your location.",
                tone: "warn",
              }
            : mediaPermission === "requesting"
              ? { text: "Waiting for your answer…", tone: "info" }
              : { text: null, tone: "info" };

  return (
    <main className="min-h-dvh w-screen overflow-y-auto bg-black bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgba(229,37,27,0.10),transparent)] px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+1.5rem)] text-white md:pb-16 md:pt-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8 md:max-w-xl">
        <header className="space-y-2 px-1">
          <AppMark className="mb-4 h-12 w-12 md:h-14 md:w-14" />
          <h1 className="text-[2.125rem] font-bold leading-tight tracking-tight">
            {isEditing ? "Emergency Profile" : "Set Up SilentPulse"}
          </h1>
          <p className="text-base leading-snug text-label-2">
            {isEditing
              ? "Only your name and emergency contact are required. Everything is stored on this device and shared with dispatch during an SOS."
              : "Add your name and an emergency contact. You can add medical details later from your profile."}
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-8">
          <FormSection title="You">
            <FieldRow label="Full Name" required>
              <input
                type="text"
                required
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Doe"
                className={fieldClassName}
              />
            </FieldRow>
          </FormSection>

          <FormSection
            title="Emergency contact"
            footer="Dispatch may call this person if you can't speak."
          >
            <FieldRow label="Name" required>
              <input
                type="text"
                required
                value={emergencyContactName}
                onChange={(e) => setEmergencyContactName(e.target.value)}
                placeholder="Alex Doe"
                className={fieldClassName}
              />
            </FieldRow>
            <FieldRow label="Phone" required>
              <input
                type="tel"
                required
                autoComplete="tel"
                value={emergencyContactPhone}
                onChange={(e) => setEmergencyContactPhone(e.target.value)}
                placeholder="555-0100"
                className={fieldClassName}
              />
            </FieldRow>
          </FormSection>

          {isEditing && (
            <FormSection
              title="Medical details (optional)"
              footer="Shared with responders so they can treat you faster."
            >
              <FieldRow label="Age">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={120}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="28"
                  className={fieldClassName}
                />
              </FieldRow>
              <FieldRow label="Blood Type">
                <select
                  value={bloodType}
                  onChange={(e) => setBloodType(e.target.value as BloodType)}
                  className={`${fieldClassName} appearance-none`}
                >
                  {BLOOD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </FieldRow>
              <FieldRow label="Medical Conditions">
                <textarea
                  rows={2}
                  value={medicalConditions}
                  onChange={(e) => setMedicalConditions(e.target.value)}
                  placeholder="Asthma, type 2 diabetes…"
                  className={`resize-none ${fieldClassName}`}
                />
              </FieldRow>
              <FieldRow label="Allergies">
                <textarea
                  rows={2}
                  value={allergies}
                  onChange={(e) => setAllergies(e.target.value)}
                  placeholder="Penicillin, peanuts…"
                  className={`resize-none ${fieldClassName}`}
                />
              </FieldRow>
              <FieldRow label="Mobility and Access">
                <textarea
                  rows={2}
                  value={mobilityNotes}
                  onChange={(e) => setMobilityNotes(e.target.value)}
                  placeholder="Uses a wheelchair, lives on the 3rd floor"
                  className={`resize-none ${fieldClassName}`}
                />
              </FieldRow>
              <FieldRow label="Sensory and De-escalation">
                <textarea
                  rows={2}
                  value={sensoryNotes}
                  onChange={(e) => setSensoryNotes(e.target.value)}
                  placeholder="Sensitive to flashing lights, non-verbal under stress"
                  className={`resize-none ${fieldClassName}`}
                />
              </FieldRow>
            </FormSection>
          )}

          <FormSection
            title="Permissions"
            footer="Allow these now so you're never asked during an emergency."
          >
            <PermissionRow
              title="Location"
              description="So dispatch can find you when you press HELP."
              status={locationStatus.text}
              statusTone={locationStatus.tone}
              actionLabel={
                locationPermission === "granted" ||
                locationPermission === "unavailable"
                  ? null
                  : locationPermission === "requesting"
                    ? "Waiting…"
                    : "Allow Location"
              }
              onAction={() => void handleEnableLocation()}
              disabled={locationPermission === "requesting"}
              icon={
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                  <path d="M20.6 3.4a.8.8 0 0 1 .2.9l-7 16.4a.8.8 0 0 1-1.5-.1l-1.9-6.9-6.9-1.9a.8.8 0 0 1-.1-1.5l16.4-7a.8.8 0 0 1 .8.1Z" />
                </svg>
              }
            />
            <PermissionRow
              title="Camera and Microphone"
              description="During an SOS, SilentPulse takes one photo and a few seconds of audio so dispatchers can see and hear what's happening."
              status={mediaStatus.text}
              statusTone={mediaStatus.tone}
              actionLabel={
                mediaPermission === "granted"
                  ? null
                  : mediaPermission === "requesting"
                    ? "Waiting…"
                    : "Allow Camera and Mic"
              }
              onAction={() => void handleEnableMedia()}
              disabled={mediaPermission === "requesting"}
              icon={
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                  <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9Zm13.5 2.2 2.9-2a1 1 0 0 1 1.6.8v7a1 1 0 0 1-1.6.8l-2.9-2V9.7Z" />
                </svg>
              }
            />
          </FormSection>

          <div className="flex flex-col gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-[3.25rem] w-full rounded-2xl bg-tint-fill px-4 text-lg font-semibold text-white transition hover:brightness-110 active:scale-[0.98] active:opacity-80 disabled:opacity-60"
            >
              {isSubmitting
                ? "Saving…"
                : isEditing
                  ? "Save Changes"
                  : "Save and Continue"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/sos")}
              className="min-h-11 w-full rounded-xl p-2.5 text-base font-medium text-tint transition hover:bg-white/5 active:opacity-60"
            >
              {isEditing ? "Back to HELP" : "Skip for Now"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh w-screen items-center justify-center bg-black text-label-2">
          <p className="text-base">Loading…</p>
        </main>
      }
    >
      <OnboardingForm />
    </Suspense>
  );
}
