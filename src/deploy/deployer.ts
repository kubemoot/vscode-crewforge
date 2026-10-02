import { dump } from 'js-yaml';
import { crewPath } from '../k8s/paths';
import { KubeError, type KubeTransport } from '../k8s/request';
import { ANNOTATIONS, type Channel, type Deployment } from '../source/deployments';
import type { SourceIdentity } from '../source/identity';
import { discoverKinds, objectPath } from '../source/live';
import { crewOf, isKubemoot, objectKey, type Manifest } from '../source/manifests';
import { render, type Exec, type ExecResult, type RenderDeps } from '../source/render';
import type { SourceEntry } from '../source/service';

/** helm and kubectl from the developer's PATH, pointed at the kubeconfig and context CrewForge uses. */
export class KubeTools {
  constructor(
    private readonly exec: Exec,
    private readonly kubeconfig: string,
    private readonly context: string,
  ) {}

  helm(args: string[]): Promise<ExecResult> {
    return this.exec('helm', ['--kube-context', this.context, ...args], { env: { KUBECONFIG: this.kubeconfig } });
  }

  kubectl(args: string[], input?: string): Promise<ExecResult> {
    return this.exec('kubectl', ['--context', this.context, ...args], { env: { KUBECONFIG: this.kubeconfig }, input });
  }
}

export type DeployChannel = Exclude<Channel, 'flux'>;

/** The channels CrewForge runs itself; Flux-managed crews change only through git. */
export function isDeployable(channel: Channel): channel is DeployChannel {
  return channel !== 'flux';
}

export interface DeployRequest {
  entry: SourceEntry;
  /** Who and what is deploying, as the developer confirmed it; stamped on the Crew. */
  identity: SourceIdentity;
  namespace: string;
  channel: DeployChannel;
  /** The Helm release; defaults to the crew's name. */
  release?: string;
  /**
   * Bundle channel only: apply just these objects (`Kind/name`), the inner loop's
   * changed set. The Crew is always applied too, so its annotations record this deploy.
   */
  only?: Set<string>;
}

/**
 * Deploys, updates, and removes crew deployments through the developer's own helm and
 * kubectl. CrewForge's own API writes stay on Kubemoot resources: it records the source,
 * owner, revision, and channel as annotations on the Crew.
 */
export class Deployer {
  constructor(
    private readonly tools: KubeTools,
    private readonly client: KubeTransport,
    private readonly deps: RenderDeps,
  ) {}

  /** Deploys or updates; returns the tool's output for the log. */
  async deploy(request: DeployRequest): Promise<string> {
    switch (request.channel) {
      case 'helm':
        return this.deployHelm(request);
      case 'bundle':
        return this.deployBundle(request);
      default:
        throw new Error(`CrewForge does not deploy through ${String(request.channel)}; change the crew through git.`);
    }
  }

  /**
   * Removes a deployment through its channel: `helm uninstall` of the release, or deletes
   * the Kubemoot objects the bundle renders. Only Kubemoot objects: a Namespace or any
   * other kind the bundle holds stays, and the operator's finalizers clean up the rest.
   */
  async remove(entry: SourceEntry, deployment: Deployment): Promise<string> {
    if (deployment.channel === 'flux') throw new Error(`Flux manages ${deployment.crew.name} in ${deployment.namespace}; remove it from your GitOps repository.`);
    if (deployment.channel === 'helm') return this.uninstall(deployment);
    const objects = (await render(entry.source, { namespace: deployment.namespace }, this.deps)).filter(isKubemoot);
    return succeeded(await this.tools.kubectl(['delete', '--ignore-not-found', '--wait=false', '-f', '-'], toDocuments(objects)), 'kubectl delete');
  }

  /** `helm uninstall` of the release that installed a crew; the release defaults to the crew's name. */
  async uninstall(deployment: Deployment): Promise<string> {
    return succeeded(await this.tools.helm(['uninstall', deployment.release ?? deployment.crew.name, '--namespace', deployment.namespace]), 'helm uninstall');
  }

  /**
   * Deletes live Kubemoot objects through the API server, one by one; one already gone
   * counts as deleted. Anything that is not a Kubemoot object is refused.
   */
  async deleteObjects(namespace: string, objects: Manifest[]): Promise<string> {
    const foreign = objects.find((m) => !isKubemoot(m));
    if (foreign) throw new Error(`CrewForge deletes only Kubemoot objects, not ${foreign.kind}/${foreign.metadata.name}.`);
    const kinds = await discoverKinds(this.client);
    const lines: string[] = [];
    for (const m of objects) {
      const kind = kinds.get(m.kind);
      if (!kind) throw new Error(`The cluster does not serve ${m.kind}.`);
      lines.push(await this.deleteOne(objectPath(kind, namespace, m.metadata.name), objectKey(m)));
    }
    return lines.join('\n');
  }

  private async deleteOne(path: string, key: string): Promise<string> {
    try {
      await this.client.request('DELETE', path);
      return `deleted ${key}`;
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return `${key} was already gone`;
      throw err;
    }
  }

  private async deployHelm(request: DeployRequest): Promise<string> {
    const crew = request.entry.crewName ?? request.entry.source.label;
    const release = request.release ?? crew;
    const args = ['upgrade', '--install', release, request.entry.source.root, '--namespace', request.namespace, '--create-namespace'];
    const output = succeeded(await this.tools.helm(args), 'helm upgrade');
    await this.client.request('PATCH', crewPath(request.namespace, crew), { metadata: { annotations: stamp(request.identity, 'helm') } });
    return output;
  }

  private async deployBundle(request: DeployRequest): Promise<string> {
    const rendered = await render(request.entry.source, { namespace: request.namespace }, this.deps);
    const crew = crewOf(rendered);
    if (crew) crew.metadata.annotations = { ...crew.metadata.annotations, ...stamp(request.identity, 'bundle') };
    const objects = request.only ? rendered.filter((m) => request.only?.has(objectKey(m)) || m === crew) : rendered;
    const args = ['apply', '--server-side', '--field-manager=crewforge', '--force-conflicts', '-f', '-'];
    return succeeded(await this.tools.kubectl(args, toDocuments(objects)), 'kubectl apply');
  }
}

function stamp(identity: SourceIdentity, channel: Channel, now = new Date()): Record<string, string> {
  const annotations: Record<string, string> = {
    [ANNOTATIONS.source]: identity.id,
    [ANNOTATIONS.channel]: channel,
    [ANNOTATIONS.deployedAt]: now.toISOString(),
  };
  if (identity.owner) annotations[ANNOTATIONS.owner] = identity.owner;
  if (identity.revision) annotations[ANNOTATIONS.revision] = identity.revision;
  return annotations;
}

/** Objects as one multi-document YAML stream, for kubectl's standard input. */
export function toDocuments(objects: Manifest[]): string {
  return objects.map((m) => dump(m, { noRefs: true, lineWidth: -1 })).join('---\n');
}

function succeeded(result: ExecResult, what: string): string {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${what} failed: ${detail}`);
  }
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
}
