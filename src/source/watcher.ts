import * as path from 'node:path';
import * as vscode from 'vscode';
import { IGNORED_PATH } from './ignored';

const YAML = /\.ya?ml$/i;

/**
 * Whether a created, changed, or deleted path can change the list of crew sources or
 * what one renders: a YAML file (Chart.yaml, a template, a manifest, a fitness file),
 * anything inside a known source (its fitness scripts), a folder that holds a source,
 * or a path with no extension, which is usually a folder being added, moved, or removed.
 */
export function affectsSources(file: string, roots: string[]): boolean {
  if (IGNORED_PATH.test(file)) return false;
  if (YAML.test(file) || path.extname(file) === '') return true;
  return roots.some((root) => file === root || file.startsWith(root + path.sep) || root.startsWith(file + path.sep));
}

/**
 * Follows the file system for Crew Sources: YAML files anywhere, folders being created
 * or deleted, and workspace folders being added or removed. A burst of events (a folder
 * deleted, a chart copied in, a rename) ends in one reload, `delayMs` after the last
 * event; events during a reload lead to one more reload after it.
 */
export class SourceWatcher implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  /** Set when a timer fires during a reload: the reload may have read the files before the change. */
  private again = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly roots: () => string[],
    private readonly reload: () => Promise<unknown>,
    private readonly delayMs = 500,
  ) {
    const yaml = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}');
    const anything = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const seen = (uri: vscode.Uri) => this.changed(uri.fsPath);
    // The YAML watcher reports YAML files; the other one reports everything else, such as folders.
    const other = (uri: vscode.Uri) => YAML.test(uri.fsPath) || this.changed(uri.fsPath);
    this.disposables.push(
      yaml,
      anything,
      yaml.onDidCreate(seen),
      yaml.onDidChange(seen),
      yaml.onDidDelete(seen),
      anything.onDidCreate(other),
      anything.onDidDelete(other),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
    );
  }

  /** A path changed; reloads once the burst it belongs to settles, when it matters. */
  changed(file: string): void {
    let roots: string[] = [];
    try {
      roots = this.roots();
    } catch {
      // Without the known roots, only YAML files and folders count.
    }
    if (affectsSources(file, roots)) this.schedule();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), this.delayMs);
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.reload();
    } catch {
      // The view shows a failed load itself; the next change tries again.
    } finally {
      this.running = false;
    }
    if (this.again) {
      this.again = false;
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
