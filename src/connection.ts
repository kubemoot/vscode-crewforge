import * as vscode from 'vscode';
import { GatewayClient, type CallerSettings, type GatewayTransport } from './discussion/gateway';
import { loadKubeconfig } from './k8s/kubeconfig';
import type { NamespaceScope } from './k8s/crews';
import { KubeClient } from './k8s/request';
import type { YamlFormat } from './source/manifests';
import { trimEnd } from './text';

/** The cluster CrewForge talks to: which kubeconfig, which context, and a client for it. */
export interface Connection {
  source: string;
  context: string;
  client: KubeClient;
  /** The API server's URL, from the kubeconfig's current cluster. */
  server?: string;
  /** The namespace the kubeconfig's context sets, as `kubectl config set-context --namespace` does. */
  namespace?: string;
  /**
   * A client for a crew's gateway, reached over a port-forward so the request
   * carries the caller's Kubernetes token. Close it with the chat that uses it.
   */
  gateway?: (namespace: string, crew: string) => GatewayTransport;
}

/** Who CrewForge is at a crew's gateway, from the settings. */
export function callerSettings(): CallerSettings {
  const settings = vscode.workspace.getConfiguration('crewforge');
  return {
    tokenServiceAccount: settings.get<string>('tokenServiceAccount', '').trim(),
    tokenAudiences: settings.get<string[]>('tokenAudiences', []).map((a) => a.trim()).filter((a) => a !== ''),
  };
}

/** Connects with the settings, or with an explicit context (to continue a saved conversation). */
export function connect(contextOverride?: string): Connection {
  const settings = vscode.workspace.getConfiguration('crewforge');
  const { source, config } = loadKubeconfig(settings.get<string>('kubeconfig', ''), contextOverride ?? settings.get<string>('context', ''));
  const client = new KubeClient(config);
  return {
    source,
    context: config.getCurrentContext(),
    client,
    server: config.getCurrentCluster()?.server,
    namespace: config.getContextObject(config.getCurrentContext())?.namespace || undefined,
    gateway: (namespace, crew) => new GatewayClient(client, config, namespace, crew, callerSettings()),
  };
}

/** The setting entry that shows every namespace you can read. */
export const ALL_NAMESPACES = '*';

/**
 * The namespaces to show crews from. The `crewforge.namespaces` setting wins when it lists
 * any (`*` there means every namespace). Left empty, the kubeconfig context's namespace is
 * the default, so a view opens with a call or two instead of reading the whole cluster
 * through a slow tunnel; with no namespace in the context, every namespace is read, in one call.
 */
export function namespaceScope(connection: Pick<Connection, 'namespace'>): NamespaceScope {
  const listed = vscode.workspace.getConfiguration('crewforge').get<string[]>('namespaces', []).map((n) => n.trim()).filter((n) => n !== '');
  if (listed.includes(ALL_NAMESPACES)) return { namespaces: [] };
  if (listed.length > 0) return { namespaces: listed };
  return connection.namespace ? { namespaces: [connection.namespace], implicit: true } : { namespaces: [] };
}

export function streamTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration('crewforge').get<number>('streamTimeoutSeconds', 600);
  return Math.max(60, seconds) * 1000;
}

export function dashboardUrl(): string {
  return vscode.workspace.getConfiguration('crewforge').get<string>('dashboardUrl', '').trim();
}

/** The dashboard URL without a trailing slash, for building paths on it; empty when unset. */
export function dashboardBase(): string {
  return trimEnd(dashboardUrl(), '/');
}

/** How the YAML views write objects: `kyaml` when the setting says so, otherwise block YAML. */
export function yamlFormat(): YamlFormat {
  return vscode.workspace.getConfiguration('crewforge').get<string>('yamlFormat', 'yaml') === 'kyaml' ? 'kyaml' : 'yaml';
}
