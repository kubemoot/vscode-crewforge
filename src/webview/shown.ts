/** The most of a page's text a webview sends back to the extension after each render. */
export const SHOWN_TEXT_LIMIT = 4000;

/** What an element shows, as one line of text, cut to the limit: what a webview reports as shown. */
export function shownText(el: Element): string {
  return (el.textContent ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, SHOWN_TEXT_LIMIT);
}
