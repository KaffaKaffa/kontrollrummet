/**
 * When something was said, the way a person would: "idag 10:34", "igår 22:56",
 * "lördag 13:30" within the week, and the date after that ("2026-11-16 18:05").
 */

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Calendar days, not 24-hour spans: 23:50 yesterday is "igår" at 00:10.
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return `idag ${time}`;
  if (days === 1) return `igår ${time}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** The time as a small label; the full date and time on hover. */
export function When({ at, className }: { at: string; className?: string }) {
  const text = whenText(at);
  if (!text) return null;
  return (
    <time className={className ? `when ${className}` : 'when'} dateTime={at} title={new Date(at).toLocaleString('sv-SE')}>
      {text}
    </time>
  );
}
