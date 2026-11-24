import * as vscode from 'vscode';
import type { KubeConfig } from '@kubernetes/client-node';
import { callerSettings } from '../connection';
import { loadKubeconfig } from '../k8s/kubeconfig';
import { KubeClient, type KubeTransport } from '../k8s/request';
import { DEFAULT_OPERATOR_NAMESPACE } from './operatorTarget';
import { MemoryRelay, type RelayParts } from './relay';

/** What a read of crew memory goes through: a relay to the operator, and the context it uses. */
export interface MemoryConnection {
  relay: MemoryRelay;
  context: string;
  config: KubeConfig;
  /** The cluster's API, to look up the ServiceAccounts a token may be minted for. */
  client: KubeTransport;
  /** The namespace the Kubemoot operator runs in. */
  operatorNamespace: string;
}

/** Connects with the settings (kubeconfig, context, and the operator's namespace). */
export function memoryConnection(parts?: RelayParts): MemoryConnection {
  const settings = vscode.workspace.getConfiguration('crewforge');
  const { config } = loadKubeconfig(settings.get<string>('kubeconfig', ''), settings.get<string>('context', ''));
  const operatorNamespace = settings.get<string>('operatorNamespace', DEFAULT_OPERATOR_NAMESPACE).trim() || DEFAULT_OPERATOR_NAMESPACE;
  const client = new KubeClient(config);
  return { relay: new MemoryRelay(client, config, operatorNamespace, parts, undefined, callerSettings()), context: config.getCurrentContext(), config, client, operatorNamespace };
}
