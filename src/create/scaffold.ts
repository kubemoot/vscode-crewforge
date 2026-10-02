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

/** The kmctl release whose `create --chart` scaffolds the starter crew of 1 to 5 specialists, as named to the user. */
export const KMCTL_MIN_VERSION = '0.14.0';

/**
 * The first kmctl build with the starter crew: release candidate 0.14.0-rc.2. By
 * semver precedence 0.14.0-rc.0 < 0.14.0-rc.2 < 0.14.0, so rc.0, which predates the
 * starter crew, is refused, while rc.2, later candidates, and every release pass.
 */
export const KMCTL_MIN_BUILD = '0.14.0-rc.2';

export const KMCTL_RELEASES = 'https://github.com/kubemoot/kmctl/releases';

/** One dot-separated prerelease identifier: numeric ones compare as numbers. */
type Identifier = number | string;

/** A semantic version: major, minor, and patch, and its prerelease identifiers (none for a release). */
export interface Version {
  release: [number, number, number];
  prerelease: Identifier[];
}

/** A prerelease identifier per semver: a number without leading zeros, or text with a letter or hyphen. */
const IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(String.raw`^v?(\d+)\.(\d+)\.(\d+)(?:-(${IDENTIFIER}(?:\.${IDENTIFIER})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`);

/** Parses "0.14.0", "v0.14.0", or "0.15.0-rc.1" (build metadata after "+" is ignored); undefined for anything else, such as "dev". */
export function parseVersion(text: string): Version | undefined {
  const m = SEMVER.exec(text.trim());
  if (!m) return undefined;
  const prerelease = m[4] ? m[4].split('.').map((id): Identifier => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease };
}

/** Semver precedence of two identifiers: numbers by value, below any text; text by ASCII order. */
function compareIdentifiers(a: Identifier, b: Identifier): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Semver precedence of two prereleases: a release (none) is above any prerelease of it. */
function comparePrereleases(a: Identifier[], b: Identifier[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifiers(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Semver precedence: negative when a is older than b, zero when equal, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] - b.release[i];
  }
  return comparePrereleases(a.prerelease, b.prerelease);
}

/** True when version is at least minimum by semver precedence, so 0.14.0-rc.1 is below 0.14.0. */
export function atLeast(version: Version, minimum: Version): boolean {
  return compareVersions(version, minimum) >= 0;
}

const MINIMUM = parseVersion(KMCTL_MIN_BUILD) as Version;

function missingKmctl(): string {
  return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later on your PATH, and none was found. Install it from ${KMCTL_RELEASES}`;
}

/**
 * Why kmctl cannot scaffold a chart here, or undefined when it can: missing from the
 * PATH, or older than the release with the starter crew. A development build
 * ("dev") cannot be compared and is trusted.
 */
export async function kmctlProblem(exec: Exec): Promise<string | undefined> {
  const result = await exec('kmctl', ['version', '--short']);
  if (result.code === 127) return missingKmctl();
  const found = result.stdout.trim();
  if (result.code !== 0) return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later; \`kmctl version\` failed: ${result.stderr.trim() || found}. Install a current release from ${KMCTL_RELEASES}`;
  const version = parseVersion(found);
  if (!version || atLeast(version, MINIMUM)) return undefined;
  return `Creating a crew needs kmctl ${KMCTL_MIN_VERSION} or later (for the starter crew); found kmctl ${found}. Install a current release from ${KMCTL_RELEASES}`;
}

/** Runs kmctl create; returns the new chart's folder and kmctl's warnings. */
export async function scaffoldCrew(exec: Exec, request: CreateCrewRequest, connection?: Pick<Connection, 'source' | 'context'>): Promise<{ root: string; warnings: string }> {
  const env = connection ? { KUBECONFIG: connection.source } : undefined;
  const result = await exec('kmctl', createArgs(request, connection?.context), { env, cwd: request.parent });
  if (result.code === 127) throw new Error(missingKmctl());
  if (result.code !== 0) throw new Error(`kmctl create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return { root: path.join(request.parent, request.name), warnings: result.stderr.trim() };
}
