/**
 * Sends every uncaught error and unhandled rejection of a webview script to `report`, so
 * the extension can log it and a page never fails without saying why.
 */
export function reportErrors(report: (message: string) => void): void {
  globalThis.addEventListener('error', (event: ErrorEvent) => report(String(event.message || event.error)));
  globalThis.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => report(String(event.reason)));
}
