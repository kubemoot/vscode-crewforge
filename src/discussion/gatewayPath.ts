import { checkName } from '../k8s/paths';

/**
 * Paths on a crew's discussion gateway, the Service `<crew>-discussion` on port 80 in the
 * crew's namespace. They are relative to the gateway's own root: CrewForge reaches it over
 * a port-forward to its pod (see `gateway.ts`), not through the API server's service proxy,
 * which strips the `Authorization` header the gateway needs to know who is asking.
 */

function gatewayBase(namespace: string, crew: string): string {
  checkName('namespace', namespace);
  const name = checkName('crew', crew);
  return `/api/v1/discussions/${name}`;
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
