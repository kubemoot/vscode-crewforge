import * as path from 'node:path';
import type { CrewSummary } from '../k8s/crews';
import type { KubeTransport } from '../k8s/request';
import { deploymentsOf, type Deployment } from './deployments';
import { discoverSources, type CrewSource, type ReadText } from './discover';
import { compare, type ResourceDrift } from './drift';
import { identify, type SourceIdentity } from './identity';
import { discoverKinds, liveObjects, type KubemootKind } from './live';
import { isFitness, listRuns, type FitnessRun } from '../fitness/fitness';
import { crewOf, objectKey, parseManifests, type Manifest } from './manifests';
import { render, type RenderDeps } from './render';

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
   * live objects. Fitness runs started from a definition are results, not source, so
   * only fitness objects the source itself renders take part.
   */
  async drift(entry: SourceEntry, deployment: Deployment, client: KubeTransport): Promise<ResourceDrift[]> {
    const rendered = await render(entry.source, { namespace: deployment.namespace, release: deployment.release }, this.deps);
    const kinds = await this.kinds(client);
    const live = await liveObjects(client, kinds, deployment.namespace, rendered, deployment.crew.name);
    const renderedKeys = new Set(rendered.map(objectKey));
    return compare(rendered, live.filter((m) => !isFitness(m) || renderedKeys.has(objectKey(m))));
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
    const rendered = await render(entry.source, { namespace }, this.deps);
    const folders = [path.join(entry.source.root, 'fitness'), path.join(path.dirname(entry.source.root), 'fitness')];
    const loose = (await Promise.all(folders.map((f) => this.yamlIn(f)))).flat();
    const unique = new Map([...rendered, ...loose].filter(isFitness).map((m) => [objectKey(m), m]));
    return [...unique.values()];
  }

  private async yamlIn(folder: string): Promise<Manifest[]> {
    try {
      return (await this.deps.readYamlFiles(folder)).flatMap(({ text }) => parseManifests(text));
    } catch {
      return [];
    }
  }

  private async describe(source: CrewSource): Promise<SourceEntry> {
    const identity = await identify(source, this.deps.exec);
    try {
      const crew = crewOf(await render(source, { namespace: PROBE_NAMESPACE }, this.deps));
      return crew ? { source, identity, crewName: crew.metadata.name } : { source, identity, error: 'renders no Crew' };
    } catch (err) {
      return { source, identity, error: err instanceof Error ? err.message : String(err) };
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
