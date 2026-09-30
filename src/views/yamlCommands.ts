import * as vscode from 'vscode';
import { provenanceOf } from '../source/provenance';
import type { SourceService } from '../source/service';
import type { CrewNode } from './crewTree';
import type { ObjectRef } from './crewDetailsTree';
import type { LiveDocuments } from './liveDocuments';
import type { ManifestDocuments, ResourceView } from './manifestDocuments';
import type { SourceNode } from './sourceTree';

/** What a YAML command is run on: a node of either view, or the document open in the editor. */
export type YamlTarget = SourceNode | CrewNode | vscode.Uri | undefined;

type ResourceNode = Extract<SourceNode, { kind: 'resource' }>;

/**
 * Compare with Live, Show Source YAML, and Show Live YAML (normalized or raw), on a
 * resource of Crew Sources, a node of the Deployed Crews view, or the diff editor's documents.
 */
export class YamlCommands {
  constructor(
    private readonly documents: ManifestDocuments,
    private readonly live: LiveDocuments,
    private readonly service: Pick<SourceService, 'located'>,
  ) {}

  async compare(target: YamlTarget): Promise<void> {
    const view = await this.viewOf(target);
    if (view) await this.documents.showDrift(view);
  }

  async showSource(target: YamlTarget): Promise<void> {
    const view = await this.viewOf(target);
    if (view) await this.documents.showSource(view);
  }

  async showLive(target: YamlTarget, raw = false): Promise<void> {
    const ref = this.refOf(target);
    if (ref) await this.live.show({ kind: 'object', ref, raw });
  }

  /** The live object a target names: a crew, a leaf with an object, a resource, or the object behind a document. */
  private refOf(target: YamlTarget): ObjectRef | undefined {
    if (target instanceof vscode.Uri) return this.documentRef(target);
    if (target?.kind === 'crew') return { kind: 'Crew', name: target.crew.name, namespace: target.crew.namespace };
    if (target?.kind === 'member') return target.view.ref;
    if (target?.kind === 'resource') return { kind: target.drift.kind, name: target.drift.name, namespace: target.deployment.namespace };
    return undefined;
  }

  private documentRef(uri: vscode.Uri): ObjectRef | undefined {
    const view = this.documents.viewOf(uri);
    if (view) return view.drift.live ? { kind: view.drift.kind, name: view.drift.name, namespace: view.namespace } : undefined;
    const shown = this.live.targetOf(uri);
    return shown?.kind === 'object' ? shown.ref : undefined;
  }

  private async viewOf(target: YamlTarget): Promise<ResourceView | undefined> {
    if (target instanceof vscode.Uri) return this.documents.viewOf(target);
    return target?.kind === 'resource' ? this.resourceView(target) : undefined;
  }

  /** A resource with the chart versions of its source and deployment, and where it starts in its source file. */
  private async resourceView(node: ResourceNode): Promise<ResourceView> {
    const { entry, deployment, drift } = node;
    const versions = { source: entry.chart?.version, deployed: provenanceOf(deployment.crew).chartVersion };
    const view: ResourceView = { namespace: deployment.namespace, drift, versions };
    if (!drift.rendered) return view;
    try {
      const located = await this.service.located(entry, deployment.namespace);
      const found = located.find((l) => l.manifest.kind === drift.kind && l.manifest.metadata.name === drift.name);
      return found?.file ? { ...view, at: { file: found.file, line: found.line } } : view;
    } catch {
      return view;
    }
  }
}
