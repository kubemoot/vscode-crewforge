import { KubeError, type KubeTransport } from '../k8s/request';
import { checkName } from '../k8s/paths';

/** The port of a crew's discussion gateway Service. */
export const GATEWAY_PORT = 80;

/** The pod and container port a crew's gateway Service leads to. */
export interface Target {
  pod: string;
  port: number;
}

interface Service {
  spec?: { selector?: Record<string, string>; ports?: { port?: number; targetPort?: number | string }[] };
}

interface Pod {
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: { containers?: { ports?: { name?: string; containerPort?: number }[] }[] };
  status?: { phase?: string; conditions?: { type?: string; status?: string }[] };
}

/** What to find: a Service, the port of it to reach, and the words for what is missing. */
export interface ServiceQuery {
  namespace: string;
  service: string;
  port: number;
  /** What a missing Service means, in plain words. */
  missing: string;
  /** What a Service with no ready pod means to check, after "has no ready pod yet." */
  notReady: string;
}

/**
 * Finds a ready pod behind a Service and the container port the Service's `port` leads to,
 * as `kubectl port-forward` does for a Service.
 */
export async function resolveServiceTarget(api: KubeTransport, q: ServiceQuery): Promise<Target> {
  const ns = checkName('namespace', q.namespace);
  const name = q.service;
  const service = await readJson<Service>(api, `/api/v1/namespaces/${ns}/services/${name}`, () => q.missing);
  const selector = Object.entries(service.spec?.selector ?? {});
  if (selector.length === 0) throw new Error(`The service ${ns}/${name} selects no pods, so there is nothing to forward to.`);
  const query = encodeURIComponent(selector.map(([k, v]) => `${k}=${v}`).join(','));
  const pods = await readJson<{ items?: Pod[] }>(api, `/api/v1/namespaces/${ns}/pods?labelSelector=${query}`, () => `Could not list the pods behind ${ns}/${name}.`);
  const pod = firstReady(pods.items ?? []);
  if (!pod?.metadata?.name) throw new Error(`The service ${ns}/${name} has no ready pod yet. ${q.notReady}`);
  return { pod: pod.metadata.name, port: containerPort(service, pod, `${ns}/${name}`, q.port) };
}

/** Finds a ready pod behind the crew's gateway Service `<crew>-discussion` and the container port its port 80 leads to. */
export async function resolveTarget(api: KubeTransport, namespace: string, crew: string): Promise<Target> {
  const ns = checkName('namespace', namespace);
  const name = `${checkName('crew', crew)}-discussion`;
  return resolveServiceTarget(api, {
    namespace: ns,
    service: name,
    port: GATEWAY_PORT,
    missing: `Crew ${crew} has no discussion service ${name} in namespace ${ns}. Check that the crew is Ready and the namespace is right.`,
    notReady: 'Check that the crew is Ready.',
  });
}

async function readJson<T>(api: KubeTransport, path: string, notFound: () => string): Promise<T> {
  try {
    return JSON.parse(await api.request('GET', path)) as T;
  } catch (err) {
    if (err instanceof KubeError && err.status === 404) throw new KubeError(notFound(), 404, err.detail);
    throw err;
  }
}

function firstReady(pods: Pod[]): Pod | undefined {
  const named = pods.filter((p) => p.metadata?.name).sort((a, b) => a.metadata!.name!.localeCompare(b.metadata!.name!));
  return named.find((p) => !p.metadata?.deletionTimestamp && p.status?.phase === 'Running' && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
}

/** The container port behind the Service's `port`: its targetPort, a number or a container port's name. */
function containerPort(service: Service, pod: Pod, label: string, port: number): number {
  const entry = service.spec?.ports?.find((p) => p.port === port);
  if (!entry) throw new Error(`The service ${label} does not serve port ${port}.`);
  const target = entry.targetPort;
  if (typeof target === 'number' && target > 0) return target;
  if (typeof target === 'string' && target !== '') return namedPort(pod, target);
  return port;
}

/** The container port the pod calls `name`. */
function namedPort(pod: Pod, name: string): number {
  const found = pod.spec?.containers?.flatMap((c) => c.ports ?? []).find((p) => p.name === name)?.containerPort;
  if (!found) throw new Error(`The pod ${pod.metadata?.name} has no container port named ${name}.`);
  return found;
}
