import * as vscode from 'vscode';
import { loadKubeconfig } from './k8s/kubeconfig';
import { KubeClient } from './k8s/request';

/** The cluster CrewForge talks to: which kubeconfig, which context, and a client for it. */
export interface Connection {
  source: string;
  context: string;
  client: KubeClient;
}

/** Connects with the settings, or with an explicit context (to continue a saved conversation). */
export function connect(contextOverride?: string): Connection {
  const settings = vscode.workspace.getConfiguration('crewforge');
  const { source, config } = loadKubeconfig(settings.get<string>('kubeconfig', ''), contextOverride ?? settings.get<string>('context', ''));
  return { source, context: config.getCurrentContext(), client: new KubeClient(config) };
}

export function namespaceFilter(): string[] {
  return vscode.workspace.getConfiguration('crewforge').get<string[]>('namespaces', []).filter((n) => n.trim() !== '');
}

export function streamTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration('crewforge').get<number>('streamTimeoutSeconds', 600);
  return Math.max(60, seconds) * 1000;
}

export function dashboardUrl(): string {
  return vscode.workspace.getConfiguration('crewforge').get<string>('dashboardUrl', '').trim();
}
