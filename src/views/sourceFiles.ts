import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { IGNORED_DIRS } from '../source/ignored';

/** One entry of a crew source's folder. */
export interface DirEntry {
  name: string;
  folder: boolean;
}

export type ListDir = (dir: string) => Promise<DirEntry[]>;

/** The real files and folders of a directory, folders first, without dependencies, git's own files, and build output. */
export const listDir: ListDir = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !(e.isDirectory() && IGNORED_DIRS.includes(e.name)))
    .map((e) => ({ name: e.name, folder: e.isDirectory() }))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
};

/**
 * A file or folder of a crew source as a tree item. Its resource URI lets VS Code apply the
 * file icon theme and Git decorations; a file opens in the normal editor on a click.
 */
export function fileItem(file: string, folder: boolean): vscode.TreeItem {
  const uri = vscode.Uri.file(file);
  const item = new vscode.TreeItem(path.basename(file), folder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.resourceUri = uri;
  item.id = `file:${file}`;
  item.contextValue = folder ? 'sourceFolder' : 'sourceFile';
  if (!folder) item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
  return item;
}
