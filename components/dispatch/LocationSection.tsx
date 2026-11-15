'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  formatAccuracy,
  queueLocationLabel,
  searchCampusBuildings,
  type IncidentLocation,
  type RankedBuilding,
} from './locationEstimate';
import { LABEL, MONO, FOCUS_RING } from './ui';

type Props = {
  location: IncidentLocation | undefined;
  /** Fallback when locations hook has not resolved yet. */
  fallbackBuildingName?: string | null;
  gps?: { lat: number; lng: number; accuracy?: number } | null;
  onConfirm: (osmId: string) => void;
  onClearConfirm: () => void;
  onFlyTo: (lng: number, lat: number) => void;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 text-[12px] leading-[1.45]">
      <dt className={`${LABEL} text-neutral-500`}>{label}</dt>
      <dd className="min-w-0 text-neutral-200">{children}</dd>
    </div>
  );
}

export function LocationSection({
  location,
  fallbackBuildingName,
  gps,
  onConfirm,
  onClearConfirm,
  onFlyTo,
}: Props) {
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchHits = useMemo(() => searchCampusBuildings(query), [query]);

  if (!gps && !location?.estimate) {
    return (
      <div className="space-y-1.5">
        <p className="text-neutral-300">No GPS received</p>
        {fallbackBuildingName && (
          <dl className="space-y-1">
            <Row label="Building">{fallbackBuildingName}</Row>
          </dl>
        )}
      </div>
    );
  }

  const loc = location;
  const est = loc?.estimate;
  const confidence = loc?.confidence ?? 'none';
  const buildings = loc?.buildings ?? [];
  const confirmed = loc?.confirmed;

  const buildingLine = () => {
    if (confidence === 'confirmed' && confirmed) {
      return (
        <>
          <Row label="Building">
            <button type="button" className={`text-left text-sky-300 hover:underline ${FOCUS_RING}`} onClick={() => onFlyTo(confirmed.lng, confirmed.lat)}>
              {confirmed.name}
            </button>
          </Row>
          <p className="text-[11px] text-emerald-400/90">Confirmed by dispatcher</p>
        </>
      );
    }
    if (confidence === 'single' && buildings[0]) {
      return (
        <Row label="Building">
          <button
            type="button"
            className={`text-left text-sky-300 hover:underline ${FOCUS_RING}`}
            onClick={() => onFlyTo(buildings[0].lng, buildings[0].lat)}
          >
            {buildings[0].name}
          </button>
        </Row>
      );
    }
    if (confidence === 'multiple' && buildings.length > 0) {
      const acc = est ? formatAccuracy(est) : '±? m';
      return (
        <Row label="Buildings">
          <span className="text-neutral-400">in range ({acc}): </span>
          {buildings.map((b, i) => (
            <span key={b.osmId}>
              {i > 0 ? ', ' : ''}
              <button type="button" className={`text-sky-300 hover:underline ${FOCUS_RING}`} onClick={() => onFlyTo(b.lng, b.lat)}>
                {b.name}
              </button>
            </span>
          ))}
        </Row>
      );
    }
    return <Row label="Building">Outdoors / no building</Row>;
  };

  const detailBuilding: RankedBuilding | null =
    confidence === 'confirmed' && confirmed
      ? confirmed
      : confidence === 'single' && buildings[0]
        ? buildings[0]
        : null;

  const pick = (b: RankedBuilding) => {
    onConfirm(b.osmId);
    setPickerOpen(false);
    setQuery('');
  };

  return (
    <div className="space-y-2">
      <dl className="space-y-1.5">
        {buildingLine()}
        {loc?.topDiffersFromBackend && loc.backendBuildingName && (
          <Row label="Backend">reported: {loc.backendBuildingName}</Row>
        )}
        {est && (
          <>
            <Row label="Accuracy">
              <span className={MONO}>{formatAccuracy(est)}</span>
            </Row>
            <Row label="Readings">
              <span className={MONO}>{est.readingCount}</span>
            </Row>
            <Row label="Coords">
              <span className={MONO}>
                {est.lat.toFixed(5)}, {est.lng.toFixed(5)}
              </span>
            </Row>
          </>
        )}
        {!est && gps && (
          <Row label="Coords">
            <span className={MONO}>
              {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
            </span>
          </Row>
        )}
        {detailBuilding && (
          <>
            {detailBuilding.type && <Row label="Type">{detailBuilding.type}</Row>}
            {detailBuilding.floors > 0 && (
              <Row label="Floors">
                <span className={MONO}>{detailBuilding.floors}</span>
              </Row>
            )}
            {detailBuilding.notes && <Row label="Notes">{detailBuilding.notes}</Row>}
          </>
        )}
        {confidence === 'multiple' && buildings.length > 0 && (
          <div className="pt-1">
            <div className={`${LABEL} mb-1 text-neutral-500`}>Per building</div>
            <ul className="space-y-1 text-[11px] text-neutral-400">
              {buildings.map((b) => (
                <li key={b.osmId}>
                  <button type="button" className={`text-sky-300 hover:underline ${FOCUS_RING}`} onClick={() => onFlyTo(b.lng, b.lat)}>
                    {b.name}
                  </button>
                  {b.floors > 0 ? ` · ${b.floors} floors` : ''}
                  {b.type ? ` · ${b.type}` : ''}
                  {b.notes ? ` · ${b.notes}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </dl>

      <div className="border-t border-neutral-800 pt-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className={LABEL}>Confirm building</span>
          {confidence === 'confirmed' && (
            <button type="button" className={`text-[11px] text-neutral-400 hover:text-neutral-200 ${FOCUS_RING}`} onClick={onClearConfirm}>
              Clear
            </button>
          )}
        </div>
        {!pickerOpen ? (
          <button
            type="button"
            className={`w-full rounded-[2px] border border-neutral-700 px-2 py-1.5 text-left text-[12px] text-neutral-300 hover:bg-neutral-900 ${FOCUS_RING}`}
            onClick={() => setPickerOpen(true)}
          >
            {confidence === 'confirmed' && confirmed
              ? confirmed.name
              : buildings.length
                ? 'Pick one in range, or search campus…'
                : 'Search campus buildings…'}
          </button>
        ) : (
          <div className="space-y-1.5">
            {buildings.length > 0 && (
              <ul className="max-h-28 space-y-0.5 overflow-y-auto">
                {buildings.map((b) => (
                  <li key={b.osmId}>
                    <button
                      type="button"
                      className={`w-full rounded-[2px] px-2 py-1 text-left text-[12px] text-neutral-200 hover:bg-neutral-800 ${FOCUS_RING}`}
                      onClick={() => pick(b)}
                    >
                      {b.name}
                      <span className="text-neutral-500"> (in range)</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all campus buildings"
              className={`w-full rounded-[2px] border border-neutral-700 bg-[#0b0b0c] px-2 py-1.5 text-[12px] text-neutral-100 outline-none ${FOCUS_RING}`}
              autoFocus
            />
            {query.trim() && (
              <ul className="max-h-28 space-y-0.5 overflow-y-auto">
                {searchHits.length === 0 && <li className="px-2 text-[11px] text-neutral-500">No matches</li>}
                {searchHits.map((b) => (
                  <li key={b.osmId}>
                    <button
                      type="button"
                      className={`w-full rounded-[2px] px-2 py-1 text-left text-[12px] text-neutral-200 hover:bg-neutral-800 ${FOCUS_RING}`}
                      onClick={() => pick(b)}
                    >
                      {b.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className={`text-[11px] text-neutral-500 hover:text-neutral-300 ${FOCUS_RING}`} onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { queueLocationLabel };
