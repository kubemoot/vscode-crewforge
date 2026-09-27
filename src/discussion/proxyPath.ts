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

/** GET here for the turn's SSE stream. */
export function streamPath(namespace: string, crew: string, conversationId: string): string {
  if (!conversationId) throw new Error('conversationId is required');
  return `${gatewayBase(namespace, crew)}/${encodeURIComponent(conversationId)}/stream`;
}
