/**
 * Extension to a dashboard page: the page's body, rendered and escaped by the extension;
 * or a line about the read under way ("Still reading from ..."), empty once it is done.
 */
export type PageHostMessage = { type: 'render'; html: string } | { type: 'status'; text: string };

/**
 * A dashboard page to the extension: it is ready; a button was pressed (with its argument,
 * if any); it now shows a rendered body (its text, so the extension knows what the person
 * sees); or the page script hit an error.
 */
export type PageMessage =
  | { type: 'ready' }
  | { type: 'action'; action: string; arg?: string }
  | { type: 'shown'; text: string }
  | { type: 'error'; message: string };
