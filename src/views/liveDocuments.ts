import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { bundleObjects, loadCrewDetails } from '../crew/details';
import { checkName } from '../k8s/paths';
import { discoverKinds, objectPath, type KubemootKind } from '../source/live';
import { KUBEMOOT_GROUP, toLiveYaml, type Manifest } from '../source/manifests';
import type { ObjectRef } from './crewDetailsTree';
import { errorText } from './errors';

export const LIVE_SCHEME = 'crewforge-live';

/** What a live document shows: one object, or a crew's Crew, Agents, PromptModules, and Skills together. */
export type LiveTarget = { kind: 'object'; ref: ObjectRef } | { kind: 'bundle'; namespace: string; crew: string };

/** The Flux kinds a crew's Deployment section can name, and where the API server serves them. */
const FLUX_PATHS: Record<string, string> = {
  HelmRelease: 'helm.toolkit.fluxcd.io/v2/namespaces/{ns}/helmreleases',
  Kustomization: 'kustomize.toolkit.fluxcd.io/v1/namespaces/{ns}/kustomizations',
};

/** The API path of a live object: a Kubemoot kind the cluster serves, or a Flux kind. */
export function livePath(ref: ObjectRef, kinds: Map<string, KubemootKind>): string {
  const kubemoot = kinds.get(ref.kind);
  if (kubemoot) return objectPath(kubemoot, ref.namespace, ref.name);
  const flux = FLUX_PATHS[ref.kind];
  if (!flux) throw new Error(`CrewForge cannot read ${ref.kind} objects`);
  return `/apis/${flux.replace('{ns}', checkName('namespace', ref.namespace))}/${encodeURIComponent(ref.name)}`;
}

export function liveUri(target: LiveTarget): vscode.Uri {
  const path = target.kind === 'bundle' ? `/${target.namespace}/${target.crew}.bundle.yaml` : `/${target.ref.namespace}/${target.ref.kind}/${target.ref.name}.yaml`;
  return vscode.Uri.parse(`${LIVE_SCHEME}:${path}`);
}

/**
 * Read-only YAML documents of live objects. The object is read when the document opens
 * and again each time it is shown, so reopening it from the tree shows the cluster now.
 */
export class LiveDocuments implements vscode.TextDocumentContentProvider {
  private readonly targets = new Map<string, LiveTarget>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly connectTo: () => Connection = () => connect()) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = this.targets.get(uri.toString());
    if (!target) return '# This live document is gone; open it again from the Crews view.\n';
    try {
      return await this.render(target);
    } catch (err) {
      return `# Cannot read it: ${errorText(err).replace(/\n/g, '\n# ')}\n`;
    }
  }

  /** Opens the live YAML of a target as a read-only YAML document. */
  async show(target: LiveTarget): Promise<void> {
    const uri = liveUri(target);
    this.targets.set(uri.toString(), target);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'yaml');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async render(target: LiveTarget): Promise<string> {
    const { client } = this.connectTo();
    const kinds = await discoverKinds(client);
    if (target.kind === 'bundle') {
      const details = await loadCrewDetails(client, kinds, target.namespace, target.crew);
      return bundleObjects(details).map(toLiveYaml).join('---\n');
    }
    const object = JSON.parse(await client.request('GET', livePath(target.ref, kinds))) as Manifest;
    return toLiveYaml({ ...object, apiVersion: object.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind: object.kind ?? target.ref.kind });
  }
}
