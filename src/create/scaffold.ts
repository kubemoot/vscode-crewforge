import * as path from 'node:path';
import type { Connection } from '../connection';
import type { Exec } from '../source/render';

export interface CreateCrewRequest {
  name: string;
  parent: string;
  members: number;
  modelFamily?: string;
}

/**
 * The kmctl command that scaffolds a crew as a Helm chart. kmctl owns the crew
 * templates; CrewForge only asks for them. With no providers given, kmctl uses every
 * ModelProvider it finds through the kubeconfig.
 */
export function createArgs(request: CreateCrewRequest, context?: string): string[] {
  const args = ['create', request.name, '--chart', '--no-input', '--members', String(request.members), '-o', request.parent];
  if (request.modelFamily) args.push('--model-family', request.modelFamily);
  if (context) args.push('--context', context);
  return args;
}

/** The first kmctl release whose `create` has `--chart` (kubemoot/kmctl v0.12.0). */
export const KMCTL_MIN_VERSION = '0.12.0';

export const KMCTL_RELEASES = 'https://github.com/kubemoot/kmctl/releases';

/** A version's major, minor, and patch; a prerelease counts as its release, since kmctl cuts each release from its last candidate. */
export type Version = [number, number, number];

/** Parses "0.12.0", "v0.12.0", or "0.13.0-rc.1"; undefined for anything else, such as "dev". */
export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-\S+)?$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when version is at least minimum. */
export function atLeast(version: Version, minimum: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

const MINIMUM: Version = [0, 12, 0];

function missingKmctl(): string {
  return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later on your PATH, and none was found. Install it from ${KMCTL_RELEASES}`;
}

/**
 * Why kmctl cannot scaffold a chart here, or undefined when it can: missing from the
 * PATH, or older than the release that added `create --chart`. A development build
 * ("dev") cannot be compared and is trusted.
 */
export async function kmctlProblem(exec: Exec): Promise<string | undefined> {
  const result = await exec('kmctl', ['version', '--short']);
  if (result.code === 127) return missingKmctl();
  const found = result.stdout.trim();
  if (result.code !== 0) return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later; \`kmctl version\` failed: ${result.stderr.trim() || found}. Install a current release from ${KMCTL_RELEASES}`;
  const version = parseVersion(found);
  if (!version || atLeast(version, MINIMUM)) return undefined;
  return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later (for create --chart); found kmctl ${found}. Install a current release from ${KMCTL_RELEASES}`;
}

/** Runs kmctl create; returns the new chart's folder and kmctl's warnings. */
export async function scaffoldCrew(exec: Exec, request: CreateCrewRequest, connection?: Pick<Connection, 'source' | 'context'>): Promise<{ root: string; warnings: string }> {
  const env = connection ? { KUBECONFIG: connection.source } : undefined;
  const result = await exec('kmctl', createArgs(request, connection?.context), { env, cwd: request.parent });
  if (result.code === 127) throw new Error(missingKmctl());
  if (result.code !== 0) throw new Error(`kmctl create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return { root: path.join(request.parent, request.name), warnings: result.stderr.trim() };
}
