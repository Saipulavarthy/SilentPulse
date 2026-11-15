# SilentPulse

**Campus emergency response that sees, hears, and routes help — quietly.**

SilentPulse is a Next.js app built for HackUMass: a phone SOS that captures live camera + audio, an AI triage pipeline that classifies the scene and scores severity, and a dispatcher dashboard that keeps human operators in the loop. When someone needs backup beyond campus units, **Twilio** places a voice call to their emergency contact and reads out a message the dispatcher wrote.

---

## What it does

### Phone SOS (`/` → `/sos`)
- Onboarding stores an **ICE medical profile** (conditions, allergies, mobility/sensory notes, emergency contact).
- One tap starts continuous telemetry: photo, short audio clip, GPS, and session updates every ~30s.
- On-device **victim instructions** adapt to the crisis and the caller’s profile (e.g. inhaler for asthma + smoke).
- Live **dispatcher → caller** text can appear on the phone during an active incident.
- Safe Walk / Overwatch keeps location warm before an SOS.

### Dual-AI triage (`POST /api/triage`)
- **Gemini** looks at the frame and listens to audio → crisis type, scene summary, and concrete cues.
- **Grok** reasons over perception + ICE + campus building + session history → severity (1–10), trend, reasons, dispatcher brief, and personalized victim steps.
- GPS is matched to **UMass Amherst building footprints** (OpenStreetMap) so the brief knows *which* building and floor context matters.
- Live sessions that go silent escalate automatically (signal-loss) so the board surfaces them first.

### Dispatcher dashboard (`/dispatch`)
- Live incident queue sorted by escalation and severity.
- Campus map with incident pins and building context.
- Status workflow: reviewing → dispatched → resolved.
- AI **response plans** for responders (radio brief, risks, actions).
- Silent on-screen messages to the caller (especially for active-threat / stealth mode).

### Twilio emergency-contact calls
When the situation warrants notifying the person listed on the ICE profile, SilentPulse uses **Twilio**:

1. The **dispatcher writes** what the contact needs to hear (situation, location, what responders are doing).
2. Twilio places an outbound **voice call** to the emergency contact’s phone number.
3. **AI text-to-speech reads that message aloud** so the contact gets a clear, consistent update without the dispatcher staying on the line.

This keeps humans in control of the wording while automating delivery under time pressure.

---

## Architecture (short)

```
Phone PWA (/sos)
  → POST /api/triage  (Gemini → building lookup → Grok → MongoDB)
  → GET  /api/incidents  (dispatcher feed + signal-loss escalation)
  → PATCH /api/incidents/[id]  (status + live caller message)
  → Twilio voice  (dispatcher script → TTS → emergency contact)
```

| Surface | Path |
|---------|------|
| Onboarding / ICE | `/` |
| SOS + telemetry | `/sos` |
| Dispatcher console | `/dispatch` |

**Stack:** Next.js 16 · React 19 · MongoDB Atlas · Gemini · Grok · MapLibre · Twilio

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment

Create `.env.local` (and the same keys in **Vercel → Environment Variables** for production):

```bash
MONGODB_URI=mongodb+srv://...
GEMINI_API_KEY=...
GROK_API_KEY=...
SILENTPULSE_SEED_KEY=...          # protects POST /api/seed

# Optional
SIGNAL_LOSS_MS=75000              # default 75s; lower for demos
GEMINI_MODEL=gemini-2.5-flash

# Twilio (emergency-contact voice outreach)
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...          # Twilio voice-capable number
TWILIO_VOICE_MODE=...
```

Without `GEMINI_API_KEY` on Vercel, triage returns `UNKNOWN` / `classificationFailed` instead of a real classification — set production env vars and redeploy.

### 3. Run locally

```bash
npm run dev
```

- Phone: [http://localhost:3000](http://localhost:3000) → complete ICE → `/sos`
- Dispatch: [http://localhost:3000/dispatch](http://localhost:3000/dispatch)  
  Use `?mock=1` for fixture incidents without Atlas.

### 4. Domain
- Phone: www.silentpulse.health
- Dispatch: www.silentpulse.health/dispatch

### 5. Seed demo ICE

```bash
curl -X POST http://localhost:3000/api/seed \
  -H "x-silentpulse-key: $SILENTPULSE_SEED_KEY"
```

Seeds `user_demo_01` (Jordan Rivera — asthma, Type 1 diabetes, etc.).

### 6. Useful scripts

```bash
# Resolve which UMass building contains a GPS point
node scripts/check-building.mjs 42.389658 -72.52813

# Refresh campus building GeoJSON from OSM (optional)
node scripts/fetch-umass-buildings.mjs
```

---

## API overview

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/triage` | SOS classify + grade + upsert incident |
| `POST` | `/api/triage/context` | Caller quick-action / “I’m safe” context |
| `GET` | `/api/incidents` | Dispatcher feed (escalates silent sessions first) |
| `PATCH` | `/api/incidents/[id]` | Status + live message to caller |
| `POST` | `/api/response-plan` | AI responder plan for an incident |
| `POST` | `/api/seed` | Upsert demo ICE profile |

---

## Crisis types

| Type | Meaning |
|------|---------|
| `ENVIRONMENTAL_HAZARD` | Fire, smoke, flood, gas, structural risk |
| `MEDICAL_CRISIS` | Injury, collapse, panic/distress without an attacker |
| `ACTIVE_THREAT` | Weapon, assault, hiding from violence (silent victim steps) |
| `UNKNOWN` | Low bandwidth / classification failed — still routed with ICE |

---

## Team notes

- Shared contract: `types/incident.ts` — change with both phone and dispatch in mind.
- Campus buildings: `data/umassBuildings.json` + `lib/buildingLookup.ts` (server) / `lib/landmarks.ts` (map).
- This is **Next.js 16** — see `AGENTS.md` / `node_modules/next/dist/docs/` before assuming older App Router habits.

---

## License / hackathon

Built for **HackUMass**. Building footprints © OpenStreetMap contributors (ODbL).
