import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CrewSource } from '../source/discover';
import type { Exec } from '../source/render';

/** One commit that touched a crew source. */
export interface Revision {
  hash: string;
  date: string;
  subject: string;
}

const FIELD = '\u001f';

/** The latest commits that touched the source, newest first. */
export async function listRevisions(exec: Exec, source: CrewSource, limit = 30): Promise<Revision[]> {
  const result = await exec('git', ['log', `-n${limit}`, `--format=%h${FIELD}%ad${FIELD}%s`, '--date=short', '--', '.'], { cwd: source.root });
  if (result.code !== 0) throw new Error(`${source.label} has no git history: ${result.stderr.trim()}`);
  return result.stdout
    .split('\n')
    .filter((line) => line.includes(FIELD))
    .map((line) => {
      const [hash, date, subject] = line.split(FIELD);
      return { hash, date, subject };
    });
}

/**
 * Writes the source as it was at a revision into a fresh folder under `base`, reading
 * git objects only, so the working tree and index stay untouched. Returns the source
 * rooted there, ready to render and deploy.
 */
export async function materialize(exec: Exec, source: CrewSource, hash: string, base: string): Promise<CrewSource> {
  const git = (...args: string[]) => exec('git', args, { cwd: source.root });
  const listing = await git('ls-tree', '-r', '--name-only', hash, '--', '.');
  if (listing.code !== 0) throw new Error(`cannot read ${source.label} at ${hash}: ${listing.stderr.trim()}`);
  const files = listing.stdout.split('\n').filter(Boolean);
  if (files.length === 0) throw new Error(`${source.label} did not exist at ${hash}`);
  const root = await fs.mkdtemp(path.join(base, `${source.label}-${hash}-`));
  for (const file of files) {
    const shown = await git('show', `${hash}:./${file}`);
    if (shown.code !== 0) throw new Error(`cannot read ${file} at ${hash}: ${shown.stderr.trim()}`);
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, shown.stdout);
  }
  return { ...source, root };
}
