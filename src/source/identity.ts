import * as path from 'node:path';
import type { CrewSource } from './discover';
import type { Exec } from './render';

/** Who and what a deployment came from, as CrewForge records it on the Crew. */
export interface SourceIdentity {
  /** `<repository>//<path in repository>`, or `local:<folder>` outside git. */
  id: string;
  /** The last commit that touched the source, with `-dirty` when it has uncommitted edits. */
  revision?: string;
  /** The developer, from git's user.email. */
  owner?: string;
}

/** Works out a source's identity from git; a source outside a repository still gets a stable id. */
export async function identify(source: CrewSource, exec: Exec): Promise<SourceIdentity> {
  const git = (...args: string[]) => exec('git', args, { cwd: source.root });
  const top = await git('rev-parse', '--show-toplevel');
  if (top.code !== 0) return { id: `local:${source.label}` };
  const remote = await git('remote', 'get-url', 'origin');
  const repo = remote.code === 0 ? normalizeRemote(remote.stdout.trim()) : `local:${path.basename(top.stdout.trim())}`;
  const relative = path.relative(top.stdout.trim(), source.root).split(path.sep).join('/');
  const [commit, status, email] = await Promise.all([
    git('log', '-1', '--format=%h', '--', '.'),
    git('status', '--porcelain', '--', '.'),
    git('config', 'user.email'),
  ]);
  const hash = commit.stdout.trim();
  const dirty = status.stdout.trim() ? '-dirty' : '';
  const revision = hash ? `${hash}${dirty}` : undefined;
  return { id: `${repo}//${relative}`, revision, owner: email.stdout.trim() || undefined };
}

/**
 * One spelling for a repository however it was cloned: no scheme, credentials, or
 * `.git`, and `git@host:org/repo` written as `host/org/repo`.
 */
export function normalizeRemote(url: string): string {
  const scp = /^[^@/]+@([^:]+):(.+)$/.exec(url);
  const bare = scp ? `${scp[1]}/${scp[2]}` : url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  return bare.replace(/\.git$/, '').replace(/\/+$/, '');
}
