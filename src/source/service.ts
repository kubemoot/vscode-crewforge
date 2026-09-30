import * as path from 'node:path';
import { FAILSAFE_SCHEMA, load } from 'js-yaml';
import type { CrewSummary } from '../k8s/crews';
import type { KubeTransport } from '../k8s/request';
import { deploymentsOf, type Deployment } from './deployments';
import { discoverSources, type CrewSource, type ReadText } from './discover';
import { compare, type ResourceDrift } from './drift';
import { identify, type SourceIdentity } from './identity';
import { discoverKinds, liveObjects, type KubemootKind } from './live';
import { isFitness, listRuns, type FitnessRun } from '../fitness/fitness';
import { helmReleaseRef, readHelmRelease, type FluxState } from '../gitops/flux';
import { crewOf, objectKey, parseManifests, type Manifest } from './manifests';
import { declarationsOf, type Declarations } from './declared';
import { locate, type Located } from './locate';
import { locationOf, render, renderWithOrigins, type Rendered, type RenderDeps, type SourceLocation } from './render';

export interface SourceDeps extends RenderDeps {
  readText: ReadText;
  /** Chart.yaml paths and every other YAML path in the workspace. */
  listFiles: () => Promise<{ charts: string[]; yamls: string[] }>;
}

/** A crew source with what CrewForge learned about it. */
export interface SourceEntry {
  source: CrewSource;
  identity: SourceIdentity;
  /** The name of the Crew it renders; absent when rendering failed. */
  crewName?: string;
  error?: string;
  /** Where a failed render points, when it says. */
  errorAt?: SourceLocation;
  /** What the source rendered when it was loaded, with the file of each object. */
  rendered?: Rendered[];
  /** A chart's name, version, appVersion, and description, from its Chart.yaml. */
  chart?: ChartInfo;
}

export interface ChartInfo {
  name?: string;
  version?: string;
  appVersion?: string;
  description?: string;
}

/** What a Chart.yaml says about the chart; nothing for a file that cannot be read or parsed. */
export async function readChart(root: string, readText: ReadText): Promise<ChartInfo | undefined> {
  try {
    // Every scalar as written: a version like 1.10 must not become the number 1.1.
    const doc = load(await readText(path.join(root, 'Chart.yaml')), { schema: FAILSAFE_SCHEMA }) as Record<string, unknown> | null;
    const text = (key: string) => (typeof doc?.[key] === 'string' ? doc[key] : undefined);
    return { name: text('name'), version: text('version'), appVersion: text('appVersion'), description: text('description') };
  } catch {
    return undefined;
  }
}

/** The crew source a file belongs to: the innermost source folder that holds it. */
export function sourceOf(entries: SourceEntry[], file: string): SourceEntry | undefined {
  const holding = entries.filter((e) => file.startsWith(e.source.root + path.sep));
  return holding.sort((a, b) => b.source.root.length - a.source.root.length)[0];
}

/** The namespace a source is rendered into only to learn its crew's name. */
const PROBE_NAMESPACE = 'default';

/** Links workspace crew sources to their live deployments and compares the two. */
export class SourceService {
  private readonly kindCache = new WeakMap<KubeTransport, Promise<Map<string, KubemootKind>>>();

  constructor(private readonly deps: SourceDeps) {}

  async load(): Promise<SourceEntry[]> {
    const { charts, yamls } = await this.deps.listFiles();
    const sources = await discoverSources(charts, yamls, this.deps.readText);
    return Promise.all(sources.map((s) => this.describe(s)));
  }

  deployments(entry: SourceEntry, crews: CrewSummary[]): Deployment[] {
    return entry.crewName ? deploymentsOf(entry.identity.id, entry.crewName, crews) : [];
  }

  /**
   * The source rendered for the deployment's namespace and release, compared with the
   * live objects, with a Flux deployment's HelmRelease values applied so the render
   * matches what Flux installs. Fitness runs started from a definition are results,
   * not source, so only fitness objects the source itself renders take part.
   */
  async drift(entry: SourceEntry, deployment: Deployment, client: KubeTransport, flux?: FluxState): Promise<ResourceDrift[]> {
    const rendered = await render(entry.source, { namespace: deployment.namespace, release: deployment.release, values: flux?.values }, this.deps);
    const kinds = await this.kinds(client);
    const live = await liveObjects(client, kinds, deployment.namespace, rendered, deployment.crew.name);
    const renderedKeys = new Set(rendered.map(objectKey));
    return compare(rendered, live.filter((m) => !isFitness(m) || renderedKeys.has(objectKey(m))));
  }

  /** The Flux HelmRelease behind a Flux-managed deployment; undefined for other channels. */
  async flux(deployment: Deployment, client: KubeTransport): Promise<FluxState | undefined> {
    const ref = helmReleaseRef(deployment.crew);
    return ref ? readHelmRelease(client, ref) : undefined;
  }

  /** The deployment's fitness runs, newest first. */
  async runs(deployment: Deployment, client: KubeTransport): Promise<FitnessRun[]> {
    return listRuns(client, await this.kinds(client), deployment.namespace, deployment.crew.name);
  }

  /**
   * The fitness definitions a source offers: the ones it renders, and the YAML in a
   * fitness/ folder inside it (a kmctl chart) or beside it (a workshop bundle).
   */
  async fitnessDefinitions(entry: SourceEntry, namespace: string): Promise<Manifest[]> {
    return (await this.fitnessLocated(entry, await this.located(entry, namespace))).map((l) => l.manifest);
  }

  /** What a source declares, each item with the file and line it starts at. */
  async declarations(entry: SourceEntry): Promise<Declarations> {
    const located = await this.located(entry);
    return declarationsOf(located, await this.fitnessLocated(entry, located), this.deps.readText);
  }

  /** The source's objects, where each starts in its files; the render from loading serves the probe namespace. */
  async located(entry: SourceEntry, namespace = PROBE_NAMESPACE): Promise<Located[]> {
    const rendered = namespace === PROBE_NAMESPACE && entry.rendered ? entry.rendered : await renderWithOrigins(entry.source, { namespace }, this.deps);
    return locate(rendered, this.deps.readText);
  }

  private async fitnessLocated(entry: SourceEntry, located: Located[]): Promise<Located[]> {
    const folders = [path.join(entry.source.root, 'fitness'), path.join(path.dirname(entry.source.root), 'fitness')];
    const loose = (await Promise.all(folders.map((f) => this.yamlIn(f)))).flat();
    const unique = new Map([...located, ...loose].filter((l) => isFitness(l.manifest)).map((l) => [objectKey(l.manifest), l]));
    return [...unique.values()];
  }

  private async yamlIn(folder: string): Promise<Located[]> {
    try {
      const files = await this.deps.readYamlFiles(folder);
      const located = await Promise.all(files.map(({ file, text }) => locate(parseManifests(text).map((manifest) => ({ manifest, file })), async () => text)));
      return located.flat();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async describe(source: CrewSource): Promise<SourceEntry> {
    const identity = await identify(source, this.deps.exec);
    const chart = source.kind === 'helm' ? await readChart(source.root, this.deps.readText) : undefined;
    try {
      const rendered = await renderWithOrigins(source, { namespace: PROBE_NAMESPACE }, this.deps);
      const crew = crewOf(rendered.map((r) => r.manifest));
      return crew ? { source, identity, chart, crewName: crew.metadata.name, rendered } : { source, identity, chart, error: 'renders no Crew' };
    } catch (err) {
      return { source, identity, chart, error: err instanceof Error ? err.message : String(err), errorAt: locationOf(err) };
    }
  }

  /** The Kubemoot kinds the cluster serves, asked once per client. */
  kinds(client: KubeTransport): Promise<Map<string, KubemootKind>> {
    let kinds = this.kindCache.get(client);
    if (!kinds) {
      kinds = discoverKinds(client);
      kinds.catch(() => this.kindCache.delete(client));
      this.kindCache.set(client, kinds);
    }
    return kinds;
  }
}
