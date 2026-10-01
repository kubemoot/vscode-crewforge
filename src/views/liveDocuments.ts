import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { bundleObjects, loadCrewDetails } from '../crew/details';
import { checkName } from '../k8s/paths';
import { clusterPath, discoverKinds, objectPath, type KubemootKind } from '../source/live';
import { dumpYaml, KUBEMOOT_GROUP, toLiveYaml, type Manifest } from '../source/manifests';
import { NORMALIZED_NOTE, normalizedYaml } from '../source/normalize';
import { toolDocument } from '../crew/toolCatalog';
import type { DetailNode, ObjectRef } from './crewDetailsTree';
import { errorText } from './errors';

export const LIVE_SCHEME = 'crewforge-live';

/**
 * What a live document shows: one object, normalized as Compare with Live shows it or
 * raw with all the server's metadata, or a crew's Crew, Agents, PromptModules, and
 * Skills together.
 */
export type LiveTarget = { kind: 'object'; ref: ObjectRef; raw?: boolean } | { kind: 'bundle'; namespace: string; crew: string } | { kind: 'text'; path: string; text: string; language: string };

/** The Flux kinds a crew's Deployment section can name, and where the API server serves them. */
const FLUX_PATHS: Record<string, string> = {
  HelmRelease: 'helm.toolkit.fluxcd.io/v2/namespaces/{ns}/helmreleases',
  Kustomization: 'kustomize.toolkit.fluxcd.io/v1/namespaces/{ns}/kustomizations',
};

/** The API path of a live object: a Kubemoot kind the cluster serves, or a Flux kind. */
export function livePath(ref: ObjectRef, kinds: Map<string, KubemootKind>): string {
  const kubemoot = kinds.get(ref.kind);
  if (kubemoot) return kubemoot.namespaced ? objectPath(kubemoot, ref.namespace, ref.name) : clusterPath(kubemoot, ref.name);
  const flux = FLUX_PATHS[ref.kind];
  if (!flux) throw new Error(`CrewForge cannot read ${ref.kind} objects`);
  return `/apis/${flux.replace('{ns}', checkName('namespace', ref.namespace))}/${encodeURIComponent(ref.name)}`;
}

export function liveUri(target: LiveTarget): vscode.Uri {
  return vscode.Uri.parse(`${LIVE_SCHEME}:${documentPath(target)}`);
}

/** Where a live document lives under the live scheme: `/<namespace>/<kind>/<name>[.raw].yaml`, or a bundle's file. */
function documentPath(target: LiveTarget): string {
  if (target.kind === 'bundle') return `/${target.namespace}/${target.crew}.bundle.yaml`;
  if (target.kind === 'text') return target.path;
  const { namespace, kind, name } = target.ref;
  const raw = target.raw ? '.raw' : '';
  return `/${namespace || 'cluster'}/${kind}/${name}${raw}.yaml`;
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
    if (!target) return '# This live document is gone; open it again from the Deployed Crews view.\n';
    try {
      return await this.render(target);
    } catch (err) {
      return `# Cannot read it: ${errorText(err).replaceAll('\n', '\n# ')}\n`;
    }
  }

  /** What an open live document shows, so a command on it can show the same object another way. */
  targetOf(uri: vscode.Uri): LiveTarget | undefined {
    return this.targets.get(uri.toString());
  }

  /** Opens the live YAML of a target, or a page of text such as a tool's details, as a read-only document. */
  async show(target: LiveTarget): Promise<void> {
    const uri = liveUri(target);
    this.targets.set(uri.toString(), target);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, target.kind === 'text' ? target.language : 'yaml');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async render(target: LiveTarget): Promise<string> {
    if (target.kind === 'text') return target.text;
    const { client } = this.connectTo();
    const kinds = await discoverKinds(client);
    if (target.kind === 'bundle') {
      const details = await loadCrewDetails(client, kinds, target.namespace, target.crew);
      return bundleObjects(details).map(toLiveYaml).join('---\n');
    }
    const read = JSON.parse(await client.request('GET', livePath(target.ref, kinds))) as Manifest;
    const object = { ...read, apiVersion: read.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind: read.kind ?? target.ref.kind };
    if (target.raw) return `# ${target.ref.kind}/${target.ref.name} as the API server holds it, with all its metadata and status.\n${dumpYaml(object)}`;
    return `${NORMALIZED_NOTE}\n# Show Live YAML (raw) shows everything.\n${normalizedYaml(object)}`;
  }
}

/** Opens a read-only page about a tool of a crew: where it comes from, what it does, who enables it, and its input schema. */
export async function showToolDetails(documents: Pick<LiveDocuments, 'show'>, node?: { kind: string }): Promise<void> {
  const member = node as DetailNode | undefined;
  if (member?.kind !== 'member' || !member.view.tool) return;
  const { info, catalog } = member.view.tool;
  const { namespace, name } = member.crew;
  await documents.show({ kind: 'text', path: `/${namespace}/${name}/tools/${encodeURIComponent(info.name)}.md`, text: toolDocument(info, catalog), language: 'markdown' });
}
