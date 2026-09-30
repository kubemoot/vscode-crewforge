import type { SessionView } from '../discussion/session';
import type { ConversationMeta } from '../store/conversation';

/** Extension host to webview: what to show. */
export type StateMessage = {
  type: 'state';
  view: SessionView;
  history: ConversationMeta[];
  /** One line about the crew for the empty state, e.g. "2 agents, coordinator x". */
  about: string;
  /** Where the page may link to. */
  links: ChatLinkState;
};

/** The agents whose source is open in the workspace, and whether a dashboard URL is set. */
export interface ChatLinkState {
  agents: string[];
  dashboard: boolean;
}

/** Extension host to webview. `prefill` puts text in the input for the person to finish and send. */
export type HostMessage = StateMessage | { type: 'prefill'; text: string };

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
  | { type: 'openDashboard' }
  /** Opens where an agent is defined: the Agent and its PromptModules in the workspace. */
  | { type: 'openAgentSource'; agent: string }
  /** Opens the turn that message `index` ends in the Kubemoot dashboard. */
  | { type: 'openTurnInDashboard'; index: number };
