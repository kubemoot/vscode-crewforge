import { checkName } from '../k8s/paths';

/**
 * API server paths to a crew's discussion gateway. The gateway is the Service
 * `<crew>-discussion` on port 80 in the crew's namespace; going through the API server's
 * service proxy means a kubeconfig is all a client needs.
 */

function gatewayBase(namespace: string, crew: string): string {
  const ns = checkName('namespace', namespace);
  const name = checkName('crew', crew);
  return `/api/v1/namespaces/${ns}/services/${name}-discussion:80/proxy/api/v1/discussions/${name}`;
}

/** POST here with `{message, conversationId}` to start a turn. */
export function startPath(namespace: string, crew: string): string {
  return gatewayBase(namespace, crew);
}

/** Where a turn's stream starts reading. */
export interface StreamPosition {
  /**
   * When the gateway queued the question, as its reply said; tells this turn's thread
   * from earlier turns'. Sent on a resume too, so the gateway can judge a thread the
   * coordinator restarts after the drop.
   */
  since?: string;
  /** The last event id received, to resume after a dropped connection without repeating events. */
  lastEventId?: string;
}

/** GET here for the turn's SSE stream. */
export function streamPath(namespace: string, crew: string, conversationId: string, position: StreamPosition = {}): string {
  if (!conversationId) throw new Error('conversationId is required');
  const query = new URLSearchParams();
  if (position.since) query.set('since', position.since);
  if (position.lastEventId) query.set('lastEventId', position.lastEventId);
  const q = query.toString();
  const search = q ? `?${q}` : '';
  return `${gatewayBase(namespace, crew)}/${encodeURIComponent(conversationId)}/stream${search}`;
}
