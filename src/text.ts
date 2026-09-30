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
