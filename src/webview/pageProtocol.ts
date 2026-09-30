/** Extension to a dashboard page: the page's body, rendered and escaped by the extension. */
export type PageHostMessage = { type: 'render'; html: string };

/** A dashboard page to the extension: it is ready, or a button was pressed (with its argument, if any). */
export type PageMessage = { type: 'ready' } | { type: 'action'; action: string; arg?: string };
