import * as vscode from 'vscode';
import { removableObjects, type CrewDetails } from '../crew/details';
import type { FitnessCommands } from '../fitness/commands';
import type { CrewSummary } from '../k8s/crews';
import { ANNOTATIONS, deploymentsOf, type Deployment } from '../source/deployments';
import type { SourceEntry } from '../source/service';
import type { DeploymentNode } from '../views/sourceTree';
import { gitOpsGuidance, type DeployCommands } from './commands';

export interface LiveCrewDeps {
  /** The workspace's crew sources: those Crew Sources loaded, or a fresh scan. */
  sources: () => Promise<SourceEntry[]>;
  deploy: Pick<DeployCommands, 'updateDeployment' | 'deployRevision' | 'removeDeployment' | 'removeUnsourced'>;
  fitness: Pick<FitnessCommands, 'runFitness'>;
  details: (crew: CrewSummary) => Promise<CrewDetails>;
  follow: (deployment: Deployment) => Promise<void>;
}

/** A live crew as a deployment, before any source is known: its channel, release, and owner come from its own marks. */
export function liveDeployment(crew: CrewSummary): Deployment {
  return deploymentsOf(crew.annotations?.[ANNOTATIONS.source] ?? '', crew.name, [crew])[0];
}

/**
 * Runs the Crew Sources lifecycle commands on a crew picked in the Crews view. Each one
 * that needs the crew's source resolves the live crew to a workspace source first: the
 * source its Crew names, else the one source that renders a crew of its name, else the
 * one the developer picks.
 */
export class LiveCrewActions {
  constructor(private readonly deps: LiveCrewDeps) {}

  async update(crew: CrewSummary): Promise<void> {
    const deployment = liveDeployment(crew);
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    const node = await this.withSource(crew, 'update it from its source');
    if (node) await this.deps.deploy.updateDeployment(node);
  }

  async deployRevision(crew: CrewSummary): Promise<void> {
    const deployment = liveDeployment(crew);
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment, 'revert the commit instead');
    const node = await this.withSource(crew, 'deploy one of its revisions');
    if (node) await this.deps.deploy.deployRevision(node);
  }

  async runFitness(crew: CrewSummary): Promise<void> {
    const node = await this.withSource(crew, 'run the fitness its source defines');
    if (node) await this.deps.fitness.runFitness(node);
  }

  async followRollout(crew: CrewSummary): Promise<void> {
    await this.deps.follow(liveDeployment(crew));
  }

  /** Removes through the source when it is known; otherwise uninstalls the Helm release, or deletes the crew's Kubemoot objects. */
  async remove(crew: CrewSummary): Promise<void> {
    const deployment = liveDeployment(crew);
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    const { node, cancelled } = await this.resolve(crew);
    if (cancelled) return;
    if (node) return this.deps.deploy.removeDeployment(node);
    if (deployment.channel === 'helm' && !deployment.release) {
      void vscode.window.showInformationMessage(`${crew.name} in ${crew.namespace} is managed by Helm but does not say which release installed it (no meta.helm.sh/release-name), so CrewForge does not remove it. Run helm uninstall for its release yourself.`);
      return;
    }
    const objects = deployment.channel === 'helm' ? [] : removableObjects(await this.deps.details(crew));
    await this.deps.deploy.removeUnsourced(deployment, objects);
  }

  /** The crew as a Crew Sources deployment, or undefined when no workspace source renders it (or the developer cancelled the pick). */
  async resolve(crew: CrewSummary): Promise<{ node?: DeploymentNode; cancelled?: boolean }> {
    const candidates = (await this.deps.sources()).filter((e) => e.crewName === crew.name);
    const named = crew.annotations?.[ANNOTATIONS.source];
    const entry = candidates.find((e) => e.identity.id === named) ?? (await pickEntry(crew, candidates));
    if (!entry) return { cancelled: candidates.length > 1 };
    const [deployment] = deploymentsOf(entry.identity.id, crew.name, [crew]);
    return { node: { kind: 'deployment', entry, deployment } };
  }

  private async withSource(crew: CrewSummary, purpose: string): Promise<DeploymentNode | undefined> {
    const { node, cancelled } = await this.resolve(crew);
    if (!node && !cancelled) void vscode.window.showInformationMessage(noSource(crew, purpose));
    return node;
  }
}

async function pickEntry(crew: CrewSummary, candidates: SourceEntry[]): Promise<SourceEntry | undefined> {
  if (candidates.length <= 1) return candidates[0];
  const choice = await vscode.window.showQuickPick(
    candidates.map((entry) => ({ label: entry.source.label, description: entry.source.root, entry })),
    { placeHolder: `Several sources render a crew named ${crew.name}; which one is deployed in ${crew.namespace}?` },
  );
  return choice?.entry;
}

export function noSource(crew: CrewSummary, purpose: string): string {
  return `CrewForge does not know the source of ${crew.name} in ${crew.namespace}, so it cannot ${purpose}. Open the folder that holds the crew's Helm chart or bundle in this workspace; Crew Sources links it by the crew's name.`;
}
