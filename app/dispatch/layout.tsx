import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

export default function DispatchLayout({ children }: LayoutProps<'/dispatch'>) {
  return (
    <div
      className={`${plexSans.variable} ${plexMono.variable} ${plexSans.className} flex h-dvh flex-col overflow-hidden bg-[#0b0b0c] text-[13px] leading-snug text-neutral-300 tabular-nums antialiased [color-scheme:dark]`}
    >
      {children}
    </div>
  );
}
