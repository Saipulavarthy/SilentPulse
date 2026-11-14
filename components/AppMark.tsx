/**
 * SilentPulse app mark: a red rounded square carrying a single pulse line.
 * The one brand element shared by the SOS screen, sidebar, and setup flow.
 */
export function AppMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-[28%] bg-[linear-gradient(160deg,#f2493f,#d21c12)] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] ${className}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[62%] w-[62%]"
      >
        <path d="M2.5 12.5h4.2l2.1-5.5 4.2 11 2.3-5.5h6.2" />
      </svg>
    </span>
  );
}
