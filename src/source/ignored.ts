import { escapeRegExp } from '../text';

/** Folders that never hold a crew source: dependencies, git's own files, and build output. */
export const IGNORED_DIRS = ['node_modules', '.git', 'dist'];

/** A glob for everything inside a folder of that name, at any depth. */
function insideGlob(dir: string): string {
  return `**/${dir}/**`;
}

/** The same folders as a glob for findFiles' exclude. */
export const IGNORED_GLOB = `{${IGNORED_DIRS.map(insideGlob).join(',')}}`;

/** Matches a path inside (or naming) one of the ignored folders, with either separator. */
export const IGNORED_PATH = new RegExp(String.raw`[\\/](${IGNORED_DIRS.map(escapeRegExp).join('|')})([\\/]|$)`);
