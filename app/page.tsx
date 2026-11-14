"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const ICE_STORAGE_KEY = "silentpulse_ice_profile";

type IceProfile = {
  fullName: string;
  age: string;
  conditions: string;
  allergies: string;
};

export default function OnboardingPage() {
  const router = useRouter();
  const [checkingProfile, setCheckingProfile] = useState(true);
  const [fullName, setFullName] = useState("");
  const [age, setAge] = useState("");
  const [conditions, setConditions] = useState("");
  const [allergies, setAllergies] = useState("");

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
      conditions: conditions.trim(),
      allergies: allergies.trim(),
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
      <div className="mx-auto flex w-full max-w-md flex-col gap-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-red-500">
            SilentPulse
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            SilentPulse Setup
          </h1>
          <p className="text-sm leading-relaxed text-zinc-400">
            Enter your emergency medical details (ICE). This is securely stored
            on your device and sent to AI dispatchers during an SOS.
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
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-red-500"
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
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-red-500"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Pre-existing Conditions
            </span>
            <textarea
              required
              rows={3}
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              placeholder="Asthma, Type 2 diabetes..."
              className="resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-red-500"
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
              className="resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-red-500"
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
