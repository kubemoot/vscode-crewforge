import * as vscode from 'vscode';
import { yamlFormat } from '../connection';
import type { ResourceDrift } from '../source/drift';
import type { YamlFormat } from '../source/manifests';
import { chartVersionBanner, NORMALIZED_NOTE, normalizedYaml } from '../source/normalize';
import type { SourceLocation } from '../source/render';

export const MANIFEST_SCHEME = 'crewforge-manifest';

/** One resource of a deployment, as Compare with Live and the YAML commands show it. */
export interface ResourceView {
  namespace: string;
  drift: ResourceDrift;
  /** The chart version of the source and of the deployment, for the banner. */
  versions?: { source?: string; deployed?: string };
  /** Where the object starts in its source file, for editing it. */
  at?: SourceLocation;
}

/** Read-only documents holding one object's YAML, live or rendered, for the diff editor and the source view. */
export class ManifestDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly views = new Map<string, ResourceView>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly format: () => YamlFormat = yamlFormat) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  /** The resource a document of this provider shows, so the diff editor's title bar commands know it. */
  viewOf(uri: vscode.Uri): ResourceView | undefined {
    return this.views.get(uri.toString());
  }

  /**
   * Opens the diff editor: the live object on the left, the source's on the right, both
   * normalized so that only what a person wrote can differ. When the chart versions of
   * the source and the deployment differ, a banner says so at the top of both sides.
   */
  async showDrift(view: ResourceView): Promise<void> {
    const { namespace, drift } = view;
    const name = `${drift.kind}-${drift.name}.yaml`;
    const header = headerOf(view);
    const format = this.format();
    const live = this.put(`/live/${namespace}/${name}`, header + (drift.live ? normalizedYaml(drift.live, format) : '# not deployed\n'), view);
    const source = this.put(`/source/${namespace}/${name}`, header + (drift.rendered ? normalizedYaml(drift.rendered, format) : '# not in the source\n'), view);
    const banner = chartVersionBanner(view.versions?.source, view.versions?.deployed);
    const versions = banner ? ` (${banner})` : '';
    const title = `${drift.kind}/${drift.name}: live in ${namespace} vs source${versions}`;
    await vscode.commands.executeCommand('vscode.diff', live, source, title);
  }

  /**
   * Opens the object the source renders, read-only, normalized as in the diff; the top
   * line links to the file it comes from, and the notification opens it there to edit.
   */
  async showSource(view: ResourceView): Promise<void> {
    const { namespace, drift, at } = view;
    const edit = at ? `# Edit it in ${vscode.Uri.file(at.file).toString()}#L${at.line + 1}\n` : '';
    const body = drift.rendered ? normalizedYaml(drift.rendered, this.format()) : '# The source does not render this object; it exists only in the cluster.\n';
    const uri = this.put(`/rendered/${namespace}/${drift.kind}-${drift.name}.yaml`, `# ${drift.kind}/${drift.name} as the source renders it for ${namespace}\n${edit}${body}`, view);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'yaml');
    await vscode.window.showTextDocument(document, { preview: true });
    if (!at) return;
    const choice = await vscode.window.showInformationMessage(`This is ${drift.kind}/${drift.name} as rendered, read-only. Edit it in its source file.`, OPEN_SOURCE);
    if (choice === OPEN_SOURCE) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(at.file), { selection: new vscode.Range(at.line, 0, at.line, 0) });
  }

  private put(path: string, text: string, view: ResourceView): vscode.Uri {
    const uri = vscode.Uri.parse(`${MANIFEST_SCHEME}:${path}`);
    this.texts.set(uri.toString(), text);
    this.views.set(uri.toString(), view);
    this.changed.fire(uri);
    return uri;
  }
}

const OPEN_SOURCE = 'Open Source File';

function headerOf(view: ResourceView): string {
  const banner = chartVersionBanner(view.versions?.source, view.versions?.deployed);
  const bannerLine = banner ? `# ${banner}\n` : '';
  return `${bannerLine}${NORMALIZED_NOTE}\n`;
}
