import { listCrews } from '../k8s/crews';
import { checkName } from '../k8s/paths';
import { KubeError, type KubeTransport } from '../k8s/request';
import type { TargetState } from './plan';

/**
 * Reads the target namespace: whether it exists (unknown when the account may not read
 * namespaces, as a workshop account may not) and the Crews already in it.
 */
export async function readTarget(client: KubeTransport, namespace: string): Promise<TargetState> {
  checkName('namespace', namespace);
  const exists = await namespaceExists(client, namespace);
  const crews = exists === false ? [] : await listCrews(client, [namespace]);
  return { namespace, exists, crews };
}

async function namespaceExists(client: KubeTransport, namespace: string): Promise<boolean | undefined> {
  try {
    await client.request('GET', `/api/v1/namespaces/${namespace}`);
    return true;
  } catch (err) {
    if (err instanceof KubeError && err.status === 404) return false;
    if (err instanceof KubeError && err.status === 403) return undefined;
    throw err;
  }
}
