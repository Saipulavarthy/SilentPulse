import type { CrisisType } from '@/types/incident';

/**
 * Small original glyphs per crisis type (16×16 viewBox, drawn in currentColor):
 * hazard = warning triangle, medical = cross, threat = crosshair, unknown = question mark.
 * Static strings, safe to set as innerHTML.
 */
const PATHS: Record<CrisisType, string> = {
  ENVIRONMENTAL_HAZARD:
    '<path d="M8 2.2 14.6 13.6H1.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.6" r="0.95" fill="currentColor"/>',
  MEDICAL_CRISIS: '<path d="M6.2 2.4h3.6v3.8h3.8v3.6H9.8v3.8H6.2V9.8H2.4V6.2h3.8z" fill="currentColor"/>',
  ACTIVE_THREAT:
    '<circle cx="8" cy="8" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M8 1.2v3.2M8 11.6v3.2M1.2 8h3.2M11.6 8h3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="8" cy="8" r="1.1" fill="currentColor"/>',
  UNKNOWN:
    '<path d="M5.7 5.9a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.5v.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="8" cy="12.7" r="0.95" fill="currentColor"/>',
};

export const CRISIS_ICON_LABEL: Record<CrisisType, string> = {
  ENVIRONMENTAL_HAZARD: 'hazard',
  MEDICAL_CRISIS: 'medical',
  ACTIVE_THREAT: 'threat',
  UNKNOWN: 'unknown',
};

export function crisisIconSvg(type: CrisisType, size = 11): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false">${PATHS[type] ?? PATHS.UNKNOWN}</svg>`;
}
