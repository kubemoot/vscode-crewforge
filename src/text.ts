/** Removes every trailing `ch` from `s`, in linear time. `ch` is a single character. */
export function trimEnd(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

/** Removes every leading and trailing `ch` from `s`, in linear time. `ch` is a single character. */
export function trimBoth(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s[start] === ch) start++;
  return trimEnd(s.slice(start), ch);
}

/** The line terminators: what `.` does not match, and where `^` and `$` stop in multiline mode. */
export const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** `text` with every character that means something in a regular expression escaped, to match it literally. */
export function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * How long a turn took: "42 s", "3 min 05 s". Empty when there is no valid duration, as
 * in conversations saved before durations were kept.
 */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 1) return 'under 1 s';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, '0')} s` : `${seconds} s`;
}

/**
 * Orders strings by UTF-16 code units, the order `sort()` uses without a compare function,
 * the same on every machine whatever its locale.
 */
export function byCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
