import * as path from 'node:path';
import { trimEnd } from '../text';
import type { CrewNode } from './crewTree';
import type { SourceNode } from './sourceTree';

/** A node of either tree, as the context menu commands receive it. */
export type AnyNode = SourceNode | CrewNode;

/** What a node names: a Kubernetes object, or a crew's deployment, by kind, name, and namespace. */
export interface Named {
  kind?: string;
  name: string;
  namespace?: string;
}

/** A file or folder on disk that a node stands for, and the line to open it at. */
export interface FileTarget {
  fsPath: string;
  folder: boolean;
  line?: number;
}

type Namer<K extends string> = (node: Extract<AnyNode, { kind: K }>) => Named | undefined;

const deployed = (n: Extract<SourceNode, { kind: 'deployment' | 'fitness' }>): Named => ({ kind: 'Crew', name: n.deployment.crew.name, namespace: n.deployment.namespace });

/** How each kind of node names what it stands for. */
const NAMERS: { [K in AnyNode['kind']]?: Namer<K> } = {
  crew: (n) => ({ kind: 'Crew', name: n.crew.name, namespace: n.crew.namespace }),
  namespace: (n) => ({ kind: 'Namespace', name: n.group.namespace }),
  member: (n) => memberNamed(n),
  source: (n) => (n.entry.crewName ? { kind: 'Crew', name: n.entry.crewName } : undefined),
  deployment: deployed,
  fitness: deployed,
  resource: (n) => ({ kind: n.drift.kind, name: n.drift.name, namespace: n.deployment.namespace }),
  run: (n) => ({ kind: n.run.kind, name: n.run.name, namespace: n.run.namespace }),
  declared: (n) => n.item.object ?? { name: n.item.label },
  file: (n) => ({ kind: n.folder ? 'Folder' : 'File', name: path.basename(n.path) }),
};

/** What a node stands for in the cluster, when it stands for one object. */
export function namedOf(node: AnyNode | undefined): Named | undefined {
  if (!node) return undefined;
  return (NAMERS[node.kind] as Namer<typeof node.kind> | undefined)?.(node);
}

function memberNamed(node: Extract<CrewNode, { kind: 'member' }>): Named | undefined {
  const { view, crew } = node;
  if (view.ref) return { kind: view.ref.kind, name: view.ref.name, namespace: view.ref.namespace || undefined };
  if (view.scenario) return { kind: 'Scenario', name: view.scenario.name, namespace: crew.namespace };
  if (view.tool) return { kind: 'Tool', name: view.tool.info.name };
  return undefined;
}

/** The name alone, for a name to paste into a command or a file. */
export function nameText(named: Named): string {
  return named.name;
}

/** `namespace/name`, the form kubectl and the dashboard use; the bare name for a cluster-scoped object. */
export function namespacedNameText(named: Named): string {
  return named.namespace ? `${named.namespace}/${named.name}` : named.name;
}

/** The file or folder a Crew Sources node stands for; nothing for a node that is only in the cluster. */
export function fileOf(node: AnyNode | undefined): FileTarget | undefined {
  if (node?.kind === 'source' || node?.kind === 'files') return { fsPath: node.entry.source.root, folder: true };
  if (node?.kind === 'file') return { fsPath: node.path, folder: node.folder };
  if (node?.kind === 'declared' && node.item.file) return { fsPath: node.item.file, folder: false, line: node.item.line };
  return undefined;
}

/** A source's main file: Chart.yaml of a chart, the file that holds the Crew of a bundle. */
export function mainFileOf(entry: { source: { kind: 'helm' | 'bundle'; root: string }; rendered?: { manifest: { kind: string }; file?: string }[] }): string | undefined {
  if (entry.source.kind === 'helm') return path.join(entry.source.root, 'Chart.yaml');
  return entry.rendered?.find((r) => r.manifest.kind === 'Crew')?.file;
}

/** A workspace folder, by name and path, for relative paths. */
export interface WorkspaceRoot {
  name: string;
  fsPath: string;
}

/**
 * The path VS Code's Copy Relative Path would copy: relative to the workspace folder that
 * holds the file, with the folder's name in front when the workspace has several, and the
 * absolute path for a file outside every folder. The folder itself copies as its name
 * alone in a multi-root workspace and as `.` in a single one.
 */
export function relativePathOf(fsPath: string, roots: WorkspaceRoot[]): string {
  const home = roots
    .filter((r) => within(r.fsPath, fsPath))
    .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
  if (!home) return fsPath;
  const relative = path.relative(home.fsPath, fsPath).split(path.sep).join('/');
  if (roots.length > 1) return relative ? `${home.name}/${relative}` : home.name;
  return relative || '.';
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The dashboard route of each kind that has a page of its own. */
const ROUTES: Record<string, string> = {
  Crew: 'crews',
  Agent: 'agents',
  PromptModule: 'promptmodules',
  Model: 'models',
  ModelServer: 'modelservers',
  EmbeddingModel: 'embeddingmodels',
  RAGSource: 'ragsources',
  MCPServer: 'mcpservers',
  MCPGateway: 'mcpgateways',
  CrewFitness: 'crewfitnesses',
};

/** The kinds the menus offer Open in Kubemoot Dashboard on; a test keeps the menus and this table the same. */
export const DASHBOARD_KINDS = [...Object.keys(ROUTES), 'CrewFitnessSuite'];

/**
 * The Kubemoot dashboard page of an object: its own page where the kind has one, the
 * Fitness page for a suite (which has none of its own), nothing for a kind without a page.
 */
export function dashboardUrlOf(base: string, named: Named): string | undefined {
  const root = trimEnd(base, '/');
  if (!root || !named.kind) return undefined;
  if (named.kind === 'CrewFitnessSuite') return `${root}/fitness`;
  const route = ROUTES[named.kind];
  if (!route) return undefined;
  const query = named.namespace ? `?namespace=${encodeURIComponent(named.namespace)}` : '';
  return `${root}/${route}/${encodeURIComponent(named.name)}${query}`;
}
