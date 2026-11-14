import { tierStyle } from './severity';
import { MONO } from './ui';

type Props = {
  score: number;
  size?: 'sm' | 'lg';
};

/** Solid tier-coloured square with the numeric score. The number is always shown. */
export function SeveritySquare({ score, size = 'sm' }: Props) {
  const t = tierStyle(score);
  const sizing = size === 'lg' ? 'h-9 w-9 text-lg' : 'h-5 w-5 text-[11px]';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[2px] font-semibold ${MONO} ${sizing} ${t.square} ${t.pulse}`}
      aria-label={`Severity ${score} of 10, ${t.label}`}
      title={`Severity ${score}/10 · ${t.label}`}
    >
      {score}
    </span>
  );
}
