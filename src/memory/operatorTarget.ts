import { checkName } from '../k8s/paths';
import { KubeError, type KubeTransport } from '../k8s/request';

/** The operator's report Service, which serves the memory export. */
export const REPORT_SERVICE = 'kubemoot-operator-report';
export const REPORT_PORT = 8082;
export const DEFAULT_OPERATOR_NAMESPACE = 'kubemoot';

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

async function readJson<T>(api: KubeTransport, path: string, notFound: string): Promise<T> {
  try {
    return JSON.parse(await api.request('GET', path)) as T;
  } catch (err) {
    if (err instanceof KubeError && err.status === 404) throw new KubeError(notFound, 404, err.detail);
    if (err instanceof KubeError && err.status === 403) {
      throw new KubeError(`Your account may not reach the Kubemoot operator's report service. The port-forward needs get on services, list on pods, and create on pods/portforward in the operator's namespace.`, 403, err.detail);
    }
    throw err;
  }
}

function firstReady(pods: Pod[]): Pod | undefined {
  const named = pods.filter((p) => p.metadata?.name).sort((a, b) => a.metadata!.name!.localeCompare(b.metadata!.name!));
  return named.find((p) => !p.metadata?.deletionTimestamp && p.status?.phase === 'Running' && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
}

function namedPort(pod: Pod, name: string): number {
  const found = pod.spec?.containers?.flatMap((c) => c.ports ?? []).find((p) => p.name === name)?.containerPort;
  if (!found) throw new Error(`The pod ${pod.metadata?.name} has no container port named ${name}.`);
  return found;
}

function containerPort(service: Service, pod: Pod): number {
  const target = service.spec?.ports?.find((p) => p.port === REPORT_PORT)?.targetPort;
  if (typeof target === 'number' && target > 0) return target;
  if (typeof target === 'string' && target !== '') return namedPort(pod, target);
  return REPORT_PORT;
}

/** Finds a ready pod behind the operator's report Service and the container port it serves on. */
export async function resolveReportTarget(api: KubeTransport, operatorNamespace: string): Promise<Target> {
  const ns = checkName('namespace', operatorNamespace);
  const where = `${ns}/${REPORT_SERVICE}`;
  const service = await readJson<Service>(api, `/api/v1/namespaces/${ns}/services/${REPORT_SERVICE}`, `The Kubemoot operator's report service ${where} was not found. Check that Kubemoot is installed, and set crewforge.operatorNamespace if it is not in ${DEFAULT_OPERATOR_NAMESPACE}.`);
  const selector = Object.entries(service.spec?.selector ?? {});
  if (selector.length === 0) throw new Error(`The service ${where} selects no pods, so there is nothing to forward to.`);
  const query = encodeURIComponent(selector.map(([k, v]) => `${k}=${v}`).join(','));
  const pods = await readJson<{ items?: Pod[] }>(api, `/api/v1/namespaces/${ns}/pods?labelSelector=${query}`, `Could not list the pods behind ${where}.`);
  const pod = firstReady(pods.items ?? []);
  if (!pod?.metadata?.name) throw new Error(`The service ${where} has no ready pod yet. Check that the Kubemoot operator is running.`);
  return { pod: pod.metadata.name, port: containerPort(service, pod) };
}
