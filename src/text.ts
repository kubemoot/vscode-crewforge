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
