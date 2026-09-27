import * as path from 'node:path';
import type { CrewSource } from './discover';
import { parseManifests, type Manifest } from './manifests';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Variables added to the inherited environment. */
  env?: Record<string, string>;
  /** Text written to the program's standard input. */
  input?: string;
}

/** Runs a program from the developer's PATH (helm, kubectl, git) without a shell. */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface RenderDeps {
  exec: Exec;
  /** The YAML files directly in a folder, with their text, in name order. */
  readYamlFiles: (dir: string) => Promise<{ file: string; text: string }[]>;
}

export interface RenderOptions {
  namespace: string;
  /** The Helm release name; defaults to the chart's folder name. */
  release?: string;
}

/** The manifests a source produces for one namespace. */
export async function render(source: CrewSource, options: RenderOptions, deps: RenderDeps): Promise<Manifest[]> {
  return source.kind === 'helm' ? renderChart(source, options, deps.exec) : renderBundle(source, options.namespace, deps);
}

async function renderChart(source: CrewSource, options: RenderOptions, exec: Exec): Promise<Manifest[]> {
  const release = options.release ?? source.label;
  const result = await exec('helm', ['template', release, source.root, '--namespace', options.namespace], { cwd: path.dirname(source.root) });
  if (result.code !== 0) throw new Error(`helm template failed for ${source.label}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return parseManifests(result.stdout).map((m) => inNamespace(m, options.namespace));
}

async function renderBundle(source: CrewSource, namespace: string, deps: RenderDeps): Promise<Manifest[]> {
  const files = await deps.readYamlFiles(source.root);
  return files.flatMap(({ file, text }) => {
    try {
      return parseManifests(text);
    } catch (err) {
      throw new Error(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }).map((m) => inNamespace(m, namespace));
}

/** Places an object in the target namespace; a bundle's own Namespace object is renamed to it. */
function inNamespace(m: Manifest, namespace: string): Manifest {
  if (m.kind === 'Namespace' && m.apiVersion === 'v1') return { ...m, metadata: { ...m.metadata, name: namespace } };
  if (CLUSTER_SCOPED.has(m.kind)) return m;
  return { ...m, metadata: { ...m.metadata, namespace } };
}

const CLUSTER_SCOPED = new Set(['ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'PriorityClass', 'StorageClass']);
