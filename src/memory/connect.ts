import * as vscode from 'vscode';
import type { KubeConfig } from '@kubernetes/client-node';
import { callerSettings } from '../connection';
import { loadKubeconfig } from '../k8s/kubeconfig';
import { KubeClient } from '../k8s/request';
import { DEFAULT_OPERATOR_NAMESPACE } from './operatorTarget';
import { MemoryRelay, type RelayParts } from './relay';

/** What a read of crew memory goes through: a relay to the operator, and the context it uses. */
export interface MemoryConnection {
  relay: MemoryRelay;
  context: string;
  config: KubeConfig;
}

/** Connects with the settings (kubeconfig, context, and the operator's namespace). */
export function memoryConnection(parts?: RelayParts): MemoryConnection {
  const settings = vscode.workspace.getConfiguration('crewforge');
  const { config } = loadKubeconfig(settings.get<string>('kubeconfig', ''), settings.get<string>('context', ''));
  const operatorNamespace = settings.get<string>('operatorNamespace', DEFAULT_OPERATOR_NAMESPACE).trim() || DEFAULT_OPERATOR_NAMESPACE;
  return { relay: new MemoryRelay(new KubeClient(config), config, operatorNamespace, parts, undefined, callerSettings()), context: config.getCurrentContext(), config };
}
