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
  /** Values that override the chart's, as a HelmRelease gives them; one `--set-json` per top-level key. */
  values?: Record<string, unknown>;
}

/** A rendered object and the source file it came from, when the render says. */
export interface Rendered {
  manifest: Manifest;
  file?: string;
}

/** A render that failed, with the source file and line (0-based) it points at when known. */
export class RenderError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** The manifests a source produces for one namespace. */
export async function render(source: CrewSource, options: RenderOptions, deps: RenderDeps): Promise<Manifest[]> {
  return (await renderWithOrigins(source, options, deps)).map((r) => r.manifest);
}

/** The manifests a source produces for one namespace, each with the file it came from. */
export async function renderWithOrigins(source: CrewSource, options: RenderOptions, deps: RenderDeps): Promise<Rendered[]> {
  const rendered = source.kind === 'helm' ? await renderChart(source, options, deps.exec) : await renderBundle(source, deps);
  return rendered.map((r) => ({ ...r, manifest: inNamespace(r.manifest, options.namespace) }));
}

async function renderChart(source: CrewSource, options: RenderOptions, exec: Exec): Promise<Rendered[]> {
  const release = options.release ?? source.label;
  const overrides = Object.entries(options.values ?? {}).flatMap(([key, value]) => ['--set-json', `${key}=${JSON.stringify(value)}`]);
  const result = await exec('helm', ['template', release, source.root, '--namespace', options.namespace, ...overrides], { cwd: path.dirname(source.root) });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    const at = helmErrorLocation(source.root, detail);
    throw new RenderError(`helm template failed for ${source.label}: ${detail}`, at?.file, at?.line);
  }
  return chartDocuments(source.root, result.stdout);
}

/**
 * Splits `helm template` output into its objects, each with the template file named by
 * the `# Source:` comment Helm writes above it.
 */
export function chartDocuments(root: string, stdout: string): Rendered[] {
  return stdout.split(/^---\s*$/m).flatMap((doc) => {
    const origin = /^# Source: (.+)$/m.exec(doc)?.[1];
    const file = origin ? chartFile(root, origin.trim()) : undefined;
    return parseManifests(doc).map((manifest) => ({ manifest, file }));
  });
}

/** A path Helm prints (`<chart name>/templates/x.yaml`) as a file under the chart folder. */
export function chartFile(root: string, printed: string): string {
  return path.join(root, ...printed.split('/').slice(1));
}

const HELM_AT = [/\(([^()\s:]+\.ya?ml):(\d+)/, /on ([^\s:]+\.ya?ml):.*?line (\d+)/];

/** Where a helm error points, from `(chart/templates/x.yaml:12)` or `on chart/templates/x.yaml: ... line 12`. */
export function helmErrorLocation(root: string, text: string): { file: string; line: number } | undefined {
  for (const pattern of HELM_AT) {
    const m = pattern.exec(text);
    if (m) return { file: chartFile(root, m[1]), line: Math.max(0, Number(m[2]) - 1) };
  }
  return undefined;
}

async function renderBundle(source: CrewSource, deps: RenderDeps): Promise<Rendered[]> {
  const files = await deps.readYamlFiles(source.root);
  return files.flatMap(({ file, text }) => {
    try {
      return parseManifests(text).map((manifest) => ({ manifest, file }));
    } catch (err) {
      const line = (err as { mark?: { line?: number } }).mark?.line;
      throw new RenderError(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`, file, line);
    }
  });
}

/** Places an object in the target namespace; a bundle's own Namespace object is renamed to it. */
function inNamespace(m: Manifest, namespace: string): Manifest {
  if (m.kind === 'Namespace' && m.apiVersion === 'v1') return { ...m, metadata: { ...m.metadata, name: namespace } };
  if (CLUSTER_SCOPED.has(m.kind)) return m;
  return { ...m, metadata: { ...m.metadata, namespace } };
}

const CLUSTER_SCOPED = new Set(['ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'PriorityClass', 'StorageClass']);
