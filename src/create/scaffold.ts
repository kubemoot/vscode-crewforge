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

/** Runs kmctl create; returns the new chart's folder and kmctl's warnings. */
export async function scaffoldCrew(exec: Exec, request: CreateCrewRequest, connection?: Pick<Connection, 'source' | 'context'>): Promise<{ root: string; warnings: string }> {
  const env = connection ? { KUBECONFIG: connection.source } : undefined;
  const result = await exec('kmctl', createArgs(request, connection?.context), { env, cwd: request.parent });
  if (result.code === 127) throw new Error('Creating a crew needs kmctl on your PATH; install it from https://github.com/kubemoot/kmctl/releases');
  if (result.code !== 0) throw new Error(`kmctl create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return { root: path.join(request.parent, request.name), warnings: result.stderr.trim() };
}
