import * as os from 'node:os';
import * as path from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';

export interface KubeconfigChoice {
  /** The file(s) the config came from, for display. */
  source: string;
  config: KubeConfig;
}

/**
 * Where the kubeconfig comes from, in order: the `crewforge.kubeconfig` setting, the
 * `KUBECONFIG` environment variable (every file in it, merged, as kubectl does), then
 * `~/.kube/config`.
 */
export function resolveKubeconfigSource(setting: string, env: NodeJS.ProcessEnv, home = os.homedir()): string {
  if (setting.trim()) return expandHome(setting.trim(), home);
  if (env.KUBECONFIG?.trim()) return env.KUBECONFIG.trim();
  return path.join(home, '.kube', 'config');
}

/** Loads the kubeconfig and selects `context` when one is given. */
export function loadKubeconfig(setting: string, context: string, env = process.env): KubeconfigChoice {
  const source = resolveKubeconfigSource(setting, env);
  const config = new KubeConfig();
  const files = source.split(path.delimiter).filter((f) => f.length > 0);
  if (files.length === 1) {
    config.loadFromFile(files[0]);
  } else {
    for (const file of files) {
      const part = new KubeConfig();
      part.loadFromFile(file);
      config.mergeConfig(part, true);
    }
    const first = firstCurrentContext(files);
    if (first) config.setCurrentContext(first);
  }
  if (context) useContext(config, context);
  if (!config.getCurrentCluster()) {
    throw new Error(`The kubeconfig at ${source} has no current context with a cluster; select one with "CrewForge: Select Kubernetes Context".`);
  }
  return { source, config };
}

/** Switches the config to a named context, failing with the names it does have. */
export function useContext(config: KubeConfig, context: string): void {
  const names = config.getContexts().map((c) => c.name);
  if (!names.includes(context)) {
    throw new Error(`Context "${context}" is not in the kubeconfig (it has: ${names.join(', ') || 'none'})`);
  }
  config.setCurrentContext(context);
}

function expandHome(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(1)) : p;
}

/** kubectl takes current-context from the first file in KUBECONFIG that sets one. */
function firstCurrentContext(files: string[]): string | undefined {
  for (const file of files) {
    const kc = new KubeConfig();
    kc.loadFromFile(file);
    if (kc.getCurrentContext()) return kc.getCurrentContext();
  }
  return undefined;
}
