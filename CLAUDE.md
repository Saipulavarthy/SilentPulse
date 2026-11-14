@AGENTS.md

# SilentPulse

HackUMass project. Next.js App Router + Tailwind + TypeScript.

- `/sos`: phone PWA that sends an SOS payload to `/api/triage`.
- `/api/triage`: Gemini classifies the scene; Grok assigns a 1-10 severity score and writes a dispatcher brief. Incidents are stored in MongoDB Atlas.
- `/dispatch`: dispatcher dashboard showing incidents live.
- `types/incident.ts`: shared contract between backend and dashboard. Changes need teammate sign-off.

## Ownership (Kiran: dispatcher dashboard, branch `dispatcher-dashboard`)

Only create or edit files under:
- `app/dispatch/`, `components/dispatch/`, `app/api/incidents/`
- `lib/landmarks.ts`, `data/umassLandmarks.json`, `types/incident.ts`

Never edit `app/sos/`, `app/api/triage/`, `models/`, or `lib/mongodb.ts` (teammates own them). If a change is needed there, tell Kiran instead of making it.

## Rules

- Before writing code, check the installed Next.js, React and react-leaflet versions in `package.json` / `node_modules` and follow that version's conventions (see `node_modules/next/dist/docs/`).
- Dashboard is dark mode only and desktop only.
- Dashboard runs entirely on mock data (`app/dispatch/mockIncidents.ts`) until Kiran says the API is ready.
