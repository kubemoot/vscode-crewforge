/** The text of any thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A tree label for an error: its first line, cut at the first sentence; the full text goes in the tooltip. */
export function errorLabel(message: string): string {
  const line = message.split('\n')[0];
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}
