import type { SessionView } from '../discussion/session';
import type { ConversationMeta } from '../store/conversation';

/** Extension host to webview. */
export type HostMessage = {
  type: 'state';
  view: SessionView;
  history: ConversationMeta[];
  /** One line about the crew for the empty state, e.g. "2 agents, coordinator x". */
  about: string;
};

/** Webview to extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'new' }
  | { type: 'open'; id: string }
  | { type: 'copy' }
  | { type: 'copyMessage'; index: number }
  /** Asks the question behind message `index` again, as a new turn. */
  | { type: 'reask'; index: number }
  | { type: 'export' }
  | { type: 'rename' }
  | { type: 'delete' }
  | { type: 'openDashboard' };
