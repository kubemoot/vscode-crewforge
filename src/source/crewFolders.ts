import * as path from 'node:path';
import { IGNORED_DIRS } from './ignored';

/** Lists the subfolders of a folder, by name; an unreadable folder has none. */
export type ListFolders = (dir: string) => Promise<string[]>;

/** The most folders listed under all crew sources together; a crew source deeper than this is unusual and the rest are left out. */
export const FOLDER_LIMIT = 5000;

/**
 * Every folder that is a crew source or inside one: each root and its subfolders, without
 * the folders that never hold a crew (dependencies, git's files, build output).
 */
export async function crewFolders(roots: string[], listFolders: ListFolders): Promise<string[]> {
  const found = new Set<string>();
  const queue = [...new Set(roots)];
  while (queue.length && found.size < FOLDER_LIMIT) {
    const dir = queue.shift() as string;
    if (found.has(dir)) continue;
    found.add(dir);
    const children = await listFolders(dir).catch(() => []);
    queue.push(...children.filter((name) => !IGNORED_DIRS.includes(name)).map((name) => path.join(dir, name)));
  }
  return [...found];
}

/**
 * The crew folders as a context key value for `resourcePath in crewforge.crewRoots`: an
 * object keyed by each folder, in both the file system form (`resourcePath` of a local
 * file) and the URI path form (`resourcePath` of a remote one, as in a WSL window).
 */
export function crewRootsKey(folders: string[], uriPath: (fsPath: string) => string): Record<string, true> {
  const key: Record<string, true> = {};
  for (const folder of folders) {
    key[folder] = true;
    key[uriPath(folder)] = true;
  }
  return key;
}
