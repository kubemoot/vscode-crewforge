import type { CrewSummary } from '../k8s/crews';
import type { KubeTransport } from '../k8s/request';
import { deploymentsOf, type Deployment } from './deployments';
import { discoverSources, type CrewSource, type ReadText } from './discover';
import { compare, type ResourceDrift } from './drift';
import { identify, type SourceIdentity } from './identity';
import { discoverKinds, liveObjects, type KubemootKind } from './live';
import { crewOf } from './manifests';
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
  private readonly kinds = new WeakMap<KubeTransport, Promise<Map<string, KubemootKind>>>();

  constructor(private readonly deps: SourceDeps) {}

  async load(): Promise<SourceEntry[]> {
    const { charts, yamls } = await this.deps.listFiles();
    const sources = await discoverSources(charts, yamls, this.deps.readText);
    return Promise.all(sources.map((s) => this.describe(s)));
  }

  deployments(entry: SourceEntry, crews: CrewSummary[]): Deployment[] {
    return entry.crewName ? deploymentsOf(entry.identity.id, entry.crewName, crews) : [];
  }

  /** The source rendered for the deployment's namespace and release, compared with the live objects. */
  async drift(entry: SourceEntry, deployment: Deployment, client: KubeTransport): Promise<ResourceDrift[]> {
    const rendered = await render(entry.source, { namespace: deployment.namespace, release: deployment.release }, this.deps);
    const kinds = await this.kindsFor(client);
    const live = await liveObjects(client, kinds, deployment.namespace, rendered, deployment.crew.name);
    return compare(rendered, live);
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

  private kindsFor(client: KubeTransport): Promise<Map<string, KubemootKind>> {
    let kinds = this.kinds.get(client);
    if (!kinds) {
      kinds = discoverKinds(client);
      kinds.catch(() => this.kinds.delete(client));
      this.kinds.set(client, kinds);
    }
    return kinds;
  }
}
