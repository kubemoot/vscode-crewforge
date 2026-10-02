import * as vscode from 'vscode';
import { checkName } from '../k8s/paths';
import type { KubeTransport } from '../k8s/request';
import { KubeError } from '../k8s/request';
import { errorText } from '../views/errors';

/** Where the Kubemoot dashboard's Service is: its namespace, name, port, and the path it serves under. */
export interface DashboardService {
  namespace: string;
  name: string;
  port: string;
  /** The path the dashboard serves under, such as "/dashboard"; undefined until known. */
  base?: string;
}

/** The paths a dashboard may serve under: at the root (standalone) or "/dashboard" (the operator chart's subchart). */
const BASE_PATHS = ['', '/dashboard'];

/**
 * The labels on the dashboard's Service: the operator chart's subchart names it
 * "dashboard", a standalone install "kubemoot-dashboard"; both are part of kubemoot.
 */
const DASHBOARD_SELECTOR = 'app.kubernetes.io/part-of=kubemoot,app.kubernetes.io/name in (dashboard,kubemoot-dashboard)';

/** Parses the `crewforge.dashboardService` setting, `namespace/name:port[/base]` (port defaults to 80). */
export function parseService(text: string): DashboardService | undefined {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)(?::(\d+))?(\/[a-z0-9-]+)?$/.exec(text.trim());
  return m ? { namespace: m[1], name: m[2], port: m[3] ?? '80', base: m[4] } : undefined;
}

interface ServicePort {
  name?: string;
  port?: number;
}

interface ServiceList {
  items?: { metadata?: { name?: string; namespace?: string }; spec?: { ports?: ServicePort[] } }[];
}

/** The Service's web port: the one named "http", else the first. */
function webPort(ports: ServicePort[] | undefined): string {
  const port = ports?.find((p) => p.name === 'http') ?? ports?.[0];
  return String(port?.port ?? 80);
}

/**
 * Finds the Kubemoot dashboard's Service: the `crewforge.dashboardService` setting, else
 * the Service the dashboard chart labels, across the cluster. Undefined when neither
 * finds one, or the account may not list Services.
 */
export async function findDashboard(client: KubeTransport): Promise<DashboardService | undefined> {
  const configured = parseService(vscode.workspace.getConfiguration('crewforge').get<string>('dashboardService', ''));
  if (configured) return configured;
  try {
    const body = JSON.parse(await client.request('GET', `/api/v1/services?labelSelector=${encodeURIComponent(DASHBOARD_SELECTOR)}`)) as ServiceList;
    const svc = body.items?.find((s) => s.metadata?.name && s.metadata.namespace);
    return svc && { namespace: svc.metadata!.namespace!, name: svc.metadata!.name!, port: webPort(svc.spec?.ports) };
  } catch {
    return undefined;
  }
}

/** The API server path that reaches `path` on the dashboard through the service proxy. */
export function dashboardPath(svc: DashboardService, path: string, base = svc.base ?? ''): string {
  return `/api/v1/namespaces/${checkName('namespace', svc.namespace)}/services/${checkName('service', svc.name)}:${svc.port}/proxy${base}${path}`;
}

/** What the Kubemoot dashboard knows about a crew's discussions. */
export interface ThreadStats {
  threads: number;
  failures: number;
  /** The newest agent failures, one line each. */
  recentFailures: string[];
  /** How many messages the count read: the stream keeps only so many. */
  messages: number;
}

interface HistoryBody {
  messages?: { subject?: string; data?: string }[];
}

interface DiscussionMessage {
  threadId?: string;
  agentName?: string;
  messageType?: string;
  content?: string;
  timestamp?: string;
}

/** Discussion counts from the newest messages of a crew's discussion subject. */
export function threadStats(body: HistoryBody): ThreadStats {
  const messages = (body.messages ?? []).map((m) => parseMessage(m.data)).filter((m): m is DiscussionMessage => m !== undefined);
  const threads = new Set(messages.map((m) => m.threadId).filter(Boolean));
  const failures = messages.filter((m) => m.messageType === 'failure');
  const recentFailures = failures.slice(-5).reverse().map((m) => `${m.agentName ?? 'an agent'}: ${firstLine(m.content) || 'failed'}`);
  return { threads: threads.size, failures: failures.length, recentFailures, messages: messages.length };
}

function parseMessage(data?: string): DiscussionMessage | undefined {
  try {
    const parsed = JSON.parse(data ?? '') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as DiscussionMessage) : undefined;
  } catch {
    return undefined;
  }
}

const firstLine = (text?: string) => (text ?? '').split('\n')[0].slice(0, 160);

/** How many of a crew's newest discussion messages the stats read. */
const HISTORY_LIMIT = 2000;

/** Read-only calls to the Kubemoot dashboard's API, through the Kubernetes service proxy. */
export class DashboardApi {
  private readonly found = new WeakMap<KubeTransport, Promise<DashboardService | undefined>>();

  /** The dashboard's Service, looked up once per client. */
  service(client: KubeTransport): Promise<DashboardService | undefined> {
    let svc = this.found.get(client);
    if (!svc) {
      svc = findDashboard(client);
      this.found.set(client, svc);
      // Not finding it is not kept: the dashboard may be installed, or the setting set, later.
      void svc.then((found) => found ?? this.found.delete(client));
    }
    return svc;
  }

  /** A crew's discussion counts, or why they are not available. */
  async threads(client: KubeTransport, namespace: string, crew: string): Promise<ThreadStats | { unavailable: string }> {
    const subject = `kubemoot.discuss.${checkName('namespace', namespace)}.${checkName('crew', crew)}.>`;
    const query = new URLSearchParams({ stream: 'KUBEMOOT_DISCUSS', subject, limit: String(HISTORY_LIMIT) });
    const body = await this.get<HistoryBody>(client, `/api/nats/history?${query.toString()}`);
    return 'unavailable' in body ? body : threadStats(body);
  }

  /** A suite run's per-scenario quality scores and judging progress. */
  async scores(client: KubeTransport, namespace: string, suite: string): Promise<SuiteScores | { unavailable: string }> {
    return this.get<SuiteScores>(client, `/api/kubemoot/crewfitnesssuites/${checkName('namespace', namespace)}/${encodeURIComponent(suite)}/scores`);
  }

  /** A suite run's iterations, read from their transcripts; the operator removes the iteration objects after a run. */
  async iterations(client: KubeTransport, namespace: string, suite: string): Promise<{ iterations?: SuiteIteration[] } | { unavailable: string }> {
    return this.get(client, `/api/kubemoot/crewfitnesssuites/${checkName('namespace', namespace)}/${encodeURIComponent(suite)}/iterations`);
  }

  private async get<T extends object>(client: KubeTransport, path: string): Promise<T | { unavailable: string }> {
    const svc = await this.service(client);
    if (!svc) return { unavailable: 'No Kubemoot dashboard found; set crewforge.dashboardService to namespace/name:port.' };
    try {
      return JSON.parse(await this.request(client, svc, path)) as T;
    } catch (err) {
      return { unavailable: `The Kubemoot dashboard did not answer: ${errorText(err)}` };
    }
  }

  /**
   * GETs path from the dashboard under its base path. While the base path is unknown it
   * tries each one, moving on only when the dashboard answers 404, and remembers the one
   * that answered.
   */
  private async request(client: KubeTransport, svc: DashboardService, path: string): Promise<string> {
    const bases = svc.base === undefined ? BASE_PATHS : [svc.base];
    let missing: unknown;
    for (const base of bases) {
      try {
        const body = await client.request('GET', dashboardPath(svc, path, base));
        svc.base = base;
        return body;
      } catch (err) {
        if (!(err instanceof KubeError && err.status === 404)) throw err;
        missing = err;
      }
    }
    throw missing;
  }
}

export interface SuiteScores {
  scores?: Record<string, number>;
  reasons?: Record<string, string>;
  complete?: boolean;
  judged?: number;
}

export interface SuiteIteration {
  scenario: string;
  iter: number;
  status: string;
  assertionsPassed: number;
  assertionsTotal: number;
  durationMs: number;
}
