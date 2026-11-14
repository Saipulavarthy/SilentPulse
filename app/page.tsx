"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const ICE_STORAGE_KEY = "silentpulse_ice_profile";

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

const inputClassName =
  "rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-red-500";

export default function OnboardingPage() {
  const router = useRouter();
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

  useEffect(() => {
    try {
      const existing = localStorage.getItem(ICE_STORAGE_KEY);
      if (existing) {
        router.replace("/sos");
        return;
      }
    } catch (error) {
      console.error("Failed to read ICE profile:", error);
    }
    setCheckingProfile(false);
  }, [router]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

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
    router.push("/sos");
  }

  if (checkingProfile) {
    return (
      <main className="flex min-h-screen w-screen items-center justify-center bg-zinc-950 text-zinc-400">
        <p className="text-sm tracking-wide">Loading SilentPulse...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen w-screen overflow-y-auto bg-zinc-950 px-5 py-10 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8 pb-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-red-500">
            SilentPulse
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            SilentPulse Setup
          </h1>
          <p className="text-sm leading-relaxed text-zinc-400">
            Enter your emergency medical details. This is stored securely on your
            device and sent to AI dispatchers during an SOS.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Full Name</span>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Doe"
              className={inputClassName}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Age</span>
            <input
              type="number"
              required
              min={1}
              max={120}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="28"
              className={inputClassName}
            />
          </label>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-300">
                Emergency Contact Name
              </span>
              <input
                type="text"
                required
                value={emergencyContactName}
                onChange={(e) => setEmergencyContactName(e.target.value)}
                placeholder="Alex Doe"
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-300">
                Emergency Contact Phone
              </span>
              <input
                type="tel"
                required
                value={emergencyContactPhone}
                onChange={(e) => setEmergencyContactPhone(e.target.value)}
                placeholder="555-0100"
                className={inputClassName}
              />
            </label>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Blood Type</span>
            <select
              required
              value={bloodType}
              onChange={(e) => setBloodType(e.target.value as BloodType)}
              className={`${inputClassName} appearance-none`}
            >
              {BLOOD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Medical Conditions
            </span>
            <textarea
              required
              rows={3}
              value={medicalConditions}
              onChange={(e) => setMedicalConditions(e.target.value)}
              placeholder="Asthma, Type 2 diabetes..."
              className={`resize-none ${inputClassName}`}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Allergies</span>
            <textarea
              required
              rows={3}
              value={allergies}
              onChange={(e) => setAllergies(e.target.value)}
              placeholder="Penicillin, peanuts..."
              className={`resize-none ${inputClassName}`}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Mobility & Access Notes
            </span>
            <textarea
              rows={3}
              value={mobilityNotes}
              onChange={(e) => setMobilityNotes(e.target.value)}
              placeholder="e.g., Uses wheelchair, lives on 3rd floor"
              className={`resize-none ${inputClassName}`}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Sensory / De-escalation Notes
            </span>
            <textarea
              rows={3}
              value={sensoryNotes}
              onChange={(e) => setSensoryNotes(e.target.value)}
              placeholder="e.g., Sensitive to flashing lights, non-verbal under stress"
              className={`resize-none ${inputClassName}`}
            />
          </label>

          <button
            type="submit"
            className="mt-2 w-full rounded-2xl bg-red-600 px-4 py-4 text-lg font-bold tracking-wide text-white transition hover:bg-red-500 active:scale-[0.98]"
          >
            Save & Arm SilentPulse
          </button>
        </form>
      </div>
    </main>
  );
}
