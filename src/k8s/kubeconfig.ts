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
  const files = source.split(path.delimiter).filter((f) => f.length > 0);
  const config = files.length === 1 ? loadFile(files[0]) : mergeFiles(files);
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

function loadFile(file: string): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromFile(file);
  return kc;
}

/**
 * Merges kubeconfig files the way kubectl does: the first file to define a cluster,
 * user, or context name wins, and current-context comes from the first file that sets
 * one. (The client library's own merge throws on a repeated name instead.)
 */
export function mergeFiles(files: string[]): KubeConfig {
  const parts = files.map(loadFile);
  const merged = new KubeConfig();
  merged.loadFromOptions({
    clusters: firstByName(parts.flatMap((p) => p.getClusters())),
    users: firstByName(parts.flatMap((p) => p.getUsers())),
    contexts: firstByName(parts.flatMap((p) => p.getContexts())),
    currentContext: parts.map((p) => p.getCurrentContext()).find((c) => c) ?? '',
  });
  return merged;
}

function firstByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.name) && seen.add(item.name));
}
