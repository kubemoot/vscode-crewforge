/** Where an open webview panel stands, for the log and the integration tests. */
export interface PanelState {
  title: string;
  /** The page script started and said so. */
  ready: boolean;
  /** The text the page shows after its last render; undefined before the first one. */
  shown?: string;
  /** Errors the page script reported. */
  errors: string[];
}

/** The text of a page's "shown" or "error" message; anything but a string counts as empty. */
export function messageText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
