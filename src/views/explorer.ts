import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { crewFolders, crewRootsKey, type ListFolders } from '../source/crewFolders';
import type { SourceNode, SourceTreeProvider } from './sourceTree';

/** The context key that lists every folder of every crew source, for the Explorer's menu. */
export const CREW_ROOTS_KEY = 'crewforge.crewRoots';

/** The subfolders of a folder, by name. */
export const listFolders: ListFolders = async (dir) => (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

export interface ExplorerParts {
  sources: Pick<SourceTreeProvider, 'known' | 'nodeForPath'>;
  reveal: (node: SourceNode) => Thenable<void>;
  openDashboard: (node: SourceNode) => void;
  listFolders?: ListFolders;
}

/**
 * The Explorer's view of crew sources: which folders are inside one (so New Kubemoot Crew
 * Here shows only outside them, and View in CrewForge only inside), and View in CrewForge
 * itself.
 */
export class ExplorerCrews {
  constructor(private readonly parts: ExplorerParts) {}

  /** Sets the context key from the sources last loaded; resolves to the folders it lists. */
  async update(): Promise<string[]> {
    const roots = this.parts.sources.known.map((e) => e.source.root);
    const folders = await crewFolders(roots, this.parts.listFolders ?? listFolders);
    await vscode.commands.executeCommand('setContext', CREW_ROOTS_KEY, crewRootsKey(folders, (p) => vscode.Uri.file(p).path));
    return folders;
  }

  /** Selects what a file or folder of a crew source stands for in Crew Sources, and opens the crew's dashboard. */
  async viewInCrewForge(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const node = target && (await this.parts.sources.nodeForPath(target.fsPath));
    if (!node || node.kind === 'message') {
      void vscode.window.showInformationMessage('This is not inside a crew source CrewForge knows. Crew Sources lists the crew charts and bundles of this workspace.');
      return;
    }
    await this.parts.reveal(node);
    this.parts.openDashboard({ kind: 'source', entry: node.entry });
  }
}
