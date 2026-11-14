'use client';

import dynamic from 'next/dynamic';
import type { Incident } from '@/types/incident';
import { TIERS, TIER_STYLES } from './severity';
import { LABEL, MONO } from './ui';

export type MapPanelProps = {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

function MapLoading() {
  return (
    <div className={`absolute inset-0 flex items-center justify-center bg-[#0b0b0c] ${LABEL}`}>Loading map…</div>
  );
}

// MapLibre needs `window` and WebGL, so the map is loaded in the browser only.
const IncidentMap = dynamic(() => import('./IncidentMap'), {
  ssr: false,
  loading: MapLoading,
});

const LEGEND: { tier: (typeof TIERS)[number]; range: string }[] = [
  { tier: 'lethal', range: '9–10' },
  { tier: 'critical', range: '7–8' },
  { tier: 'urgent', range: '4–6' },
  { tier: 'low', range: '1–3' },
];

export function MapPanel(props: MapPanelProps) {
  return (
    <section className="relative isolate min-h-0 overflow-hidden" aria-label="Incident map">
      <IncidentMap {...props} />

      {/* Sits above the attribution, which wraps to two lines in satellite mode. */}
      <div className="pointer-events-none absolute bottom-16 left-3 z-[1000] border border-neutral-800 bg-[#0b0b0c]/90 px-2.5 py-2">
        <div className={`${LABEL} mb-1.5`}>Severity</div>
        <ul className="space-y-1">
          {LEGEND.map(({ tier, range }) => (
            <li key={tier} className="flex items-center gap-2 text-[12px]">
              <span className={`h-2.5 w-2.5 rounded-[2px] ${TIER_STYLES[tier].square}`} aria-hidden />
              <span className="w-14 text-neutral-300">{TIER_STYLES[tier].label}</span>
              <span className={`${MONO} text-neutral-500`}>{range}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
