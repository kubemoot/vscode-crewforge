/** Folders that never hold a crew source: dependencies, git's own files, and build output. */
export const IGNORED_DIRS = ['node_modules', '.git', 'dist'];

/** The same folders as a glob for findFiles' exclude. */
export const IGNORED_GLOB = `{${IGNORED_DIRS.map((d) => `**/${d}/**`).join(',')}}`;

/** Matches a path inside (or naming) one of the ignored folders, with either separator. */
export const IGNORED_PATH = new RegExp(String.raw`[\\/](${IGNORED_DIRS.map((d) => d.replace('.', String.raw`\.`)).join('|')})([\\/]|$)`);
