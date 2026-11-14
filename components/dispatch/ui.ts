// Shared class tokens for the dispatch UI. Literal strings so Tailwind picks them up.

/** IBM Plex Mono, for IDs, times, coordinates and scores. */
export const MONO = 'font-[family-name:var(--font-plex-mono)] tabular-nums';

/** Uppercase 11px column/section label. */
export const LABEL = 'text-[11px] font-medium uppercase tracking-[0.06em] text-neutral-500';

/** The single accent colour, used only for selection and focus. */
export const ACCENT_TEXT = 'text-sky-400';
export const ACCENT_BG = 'bg-sky-400/[0.09]';
export const ACCENT_OUTLINE = 'outline-sky-400';
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-sky-400';
