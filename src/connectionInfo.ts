import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Connection } from './connection';
import type { KubeTransport } from './k8s/request';
import { splitChart } from './source/provenance';
import { detailLine, errorText, rawDetail, SELECT_CONTEXT, unreachableReason } from './views/errors';

/** The Kubemoot operator as found in the cluster: its image, chart, and namespace. */
export interface KubemootVersion {
  namespace: string;
  image?: string;
  /** The image's tag, which is the operator's version. */
  version?: string;
  chart?: string;
}

/** What CrewForge is connected to, for the status bar, the Deployed Crews view, and bug reports. */
export interface ConnectionInfo {
  crewforge: string;
  context?: string;
  kubeconfig?: string;
  server?: string;
  kubernetes?: string;
  kubemoot?: KubemootVersion;
  /** Why Kubemoot's version is not known, when the cluster answered but the operator was not found. */
  kubemootMissing?: string;
  /** Why the cluster (or the kubeconfig) could not be read at all, in plain words. */
  unreachable?: string;
  /** The raw error behind `unreachable`, such as "connect ECONNREFUSED 127.0.0.1:6443". */
  unreachableDetail?: string;
}

const OPERATOR_SELECTOR = 'app.kubernetes.io/name=kubemoot-operator';
const CREW_CRD = '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/crews.kubemoot.ai';

interface DeploymentList {
  items?: { metadata?: { namespace?: string; labels?: Record<string, string> }; spec?: { template?: { spec?: { containers?: { name?: string; image?: string }[] } } } }[];
}

/** The tag of an image reference, without a digest; undefined when it has none. */
export function imageTag(image?: string): string | undefined {
  const withoutDigest = image?.split('@')[0] ?? '';
  const last = withoutDigest.split('/').pop() ?? '';
  const colon = last.lastIndexOf(':');
  return colon > 0 ? last.slice(colon + 1) : undefined;
}

type OperatorDeployment = NonNullable<DeploymentList['items']>[number];

/** The operator's image: the manager container's, else the first container's. */
function operatorImage(deployment: OperatorDeployment): string | undefined {
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  return (containers.find((c) => c.name === 'manager') ?? containers[0])?.image;
}

function versionFrom(list: DeploymentList): KubemootVersion | undefined {
  const deployment = list.items?.[0];
  if (!deployment) return undefined;
  const image = operatorImage(deployment);
  const { metadata = {} } = deployment;
  return { namespace: metadata.namespace ?? '', image, version: imageTag(image), chart: splitChart(metadata.labels?.['helm.sh/chart']).version };
}

async function listOperators(client: KubeTransport, scope: string): Promise<KubemootVersion | undefined> {
  const body = JSON.parse(await client.request('GET', `/apis/apps/v1${scope}/deployments?labelSelector=${encodeURIComponent(OPERATOR_SELECTOR)}`)) as DeploymentList;
  return versionFrom(body);
}

/**
 * Finds the Kubemoot operator by its label, across the cluster; when listing across the
 * cluster is not allowed, in the namespace of the Helm release that installed the Crew
 * CRD. Its image tag is the operator's version, and its helm.sh/chart label the chart's.
 */
export async function findKubemoot(client: KubeTransport): Promise<KubemootVersion | undefined> {
  try {
    return await listOperators(client, '');
  } catch {
    const crd = JSON.parse(await client.request('GET', CREW_CRD)) as { metadata?: { annotations?: Record<string, string> } };
    const namespace = crd.metadata?.annotations?.['meta.helm.sh/release-namespace'];
    return namespace ? listOperators(client, `/namespaces/${encodeURIComponent(namespace)}`) : undefined;
  }
}

/** Reads the Kubernetes and Kubemoot versions of the connection; says plainly when the cluster cannot be reached. */
export async function readConnectionInfo(connect: () => Connection, crewforge: string): Promise<ConnectionInfo> {
  let connection: Connection;
  try {
    connection = connect();
  } catch (err) {
    return { crewforge, ...failure(err) };
  }
  const base: ConnectionInfo = { crewforge, context: connection.context, kubeconfig: connection.source, server: connection.server };
  try {
    const version = JSON.parse(await connection.client.request('GET', '/version')) as { gitVersion?: string };
    base.kubernetes = version.gitVersion;
  } catch (err) {
    return { ...base, ...failure(err) };
  }
  try {
    const kubemoot = await findKubemoot(connection.client);
    return kubemoot ? { ...base, kubemoot } : { ...base, kubemootMissing: 'no Kubemoot operator found' };
  } catch (err) {
    return { ...base, kubemootMissing: `cannot tell (${errorText(err)})` };
  }
}

/** Why the connection failed, in plain words, with the raw error when it says more. */
function failure(err: unknown): Pick<ConnectionInfo, 'unreachable' | 'unreachableDetail'> {
  const raw = rawDetail(err);
  return raw ? { unreachable: unreachableReason(err), unreachableDetail: raw } : { unreachable: unreachableReason(err) };
}

/** The connection as lines of text, for a tooltip, the quick pick, and a bug report. */
export function connectionLines(info: ConnectionInfo): string[] {
  const lines = [`CrewForge ${info.crewforge}`];
  if (info.context) lines.push(`Context: ${info.context}`);
  if (info.server) lines.push(`Server: ${info.server}`);
  if (info.kubeconfig) lines.push(`Kubeconfig: ${info.kubeconfig}`);
  if (info.unreachable) return [...lines, info.unreachable, ...(info.unreachableDetail ? [detailLine(info.unreachableDetail)] : [])];
  lines.push(`Kubernetes ${info.kubernetes ?? 'version unknown'}`);
  lines.push(info.kubemoot ? kubemootLine(info.kubemoot) : `Kubemoot: ${info.kubemootMissing}`);
  return lines;
}

function kubemootLine(k: KubemootVersion): string {
  const chart = k.chart ? `, chart ${k.chart}` : '';
  return `Kubemoot ${k.version ?? k.image ?? 'version unknown'}${chart} (operator in ${k.namespace})`;
}

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube', 'config');

/** The status bar text: the context, and the kubeconfig file's name when it is not the default one. */
export function statusText(info: Pick<ConnectionInfo, 'context' | 'kubeconfig' | 'unreachable'>): string {
  if (!info.context) return '$(debug-disconnect) not connected';
  const file = info.kubeconfig && info.kubeconfig !== DEFAULT_KUBECONFIG ? ` (${path.basename(info.kubeconfig)})` : '';
  return info.unreachable ? `$(debug-disconnect) ${info.context}${file}: no connection` : `$(plug) ${info.context}${file}`;
}

/**
 * The status bar item that always shows what CrewForge is connected to. Clicking it
 * selects the Kubernetes context; hovering shows the versions.
 */
export class ConnectionStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  latest?: ConnectionInfo;

  constructor(
    private readonly connect: () => Connection,
    private readonly crewforge: string,
  ) {
    this.item.command = { ...SELECT_CONTEXT };
  }

  /** Reads the connection again and redraws the item; resolves to what it read. */
  async update(): Promise<ConnectionInfo> {
    const info = await readConnectionInfo(this.connect, this.crewforge);
    this.latest = info;
    this.item.text = statusText(info);
    this.item.tooltip = [...connectionLines(info), '', 'Click to select the Kubernetes context.'].join('\n');
    this.item.show();
    return info;
  }

  dispose(): void {
    this.item.dispose();
  }
}

const COPY = 'Copy for a bug report';

/** Shows the connection details in a quick pick, with Select Kubernetes Context and a Copy item for bug reports. */
export async function showConnectionInfo(info: ConnectionInfo): Promise<void> {
  const lines = connectionLines(info);
  const actions = [{ label: `$(server-environment) ${SELECT_CONTEXT.title}` }, { label: `$(copy) ${COPY}` }];
  const choice = await vscode.window.showQuickPick([...lines.map((label) => ({ label })), ...actions], { title: 'CrewForge connection' });
  if (choice?.label.endsWith(COPY)) await vscode.env.clipboard.writeText(lines.join('\n'));
  if (choice?.label.endsWith(SELECT_CONTEXT.title)) await vscode.commands.executeCommand(SELECT_CONTEXT.command);
}
