import * as path from 'node:path';
import { crewOf, parseManifests } from './manifests';

/**
 * A crew's source in the workspace: a Helm chart whose templates define a Crew, or a
 * folder of plain manifests (a bundle) that contains one.
 */
export interface CrewSource {
  kind: 'helm' | 'bundle';
  /** The chart directory, or the folder holding the bundle's Crew manifest. */
  root: string;
  /** The folder name, for display. */
  label: string;
}

export type ReadText = (file: string) => Promise<string>;

const CREW_TEMPLATE = /^kind:\s*Crew\s*$/m;
const KUBEMOOT_API = /^apiVersion:\s*kubemoot\.ai\//m;

/**
 * Finds crew sources among workspace files. `charts` are the Chart.yaml paths, `yamls`
 * every other YAML file; a YAML file inside a chart never counts as a bundle.
 */
export async function discoverSources(charts: string[], yamls: string[], read: ReadText): Promise<CrewSource[]> {
  const chartRoots = charts.map((c) => path.dirname(c));
  const insideChart = (file: string) => chartRoots.some((root) => file.startsWith(root + path.sep));
  const helm = await filterAsync(chartRoots, (root) => isCrewChart(root, yamls, read));
  const bundleRoots = new Set<string>();
  for (const file of yamls.filter((f) => !insideChart(f))) {
    if (await definesCrew(file, read)) bundleRoots.add(path.dirname(file));
  }
  const sources: CrewSource[] = [
    ...helm.map((root) => ({ kind: 'helm' as const, root, label: path.basename(root) })),
    ...[...bundleRoots].map((root) => ({ kind: 'bundle' as const, root, label: path.basename(root) })),
  ];
  return sources.sort((a, b) => a.root.localeCompare(b.root));
}

/** A chart is a crew chart when one of its templates declares a Kubemoot Crew. */
async function isCrewChart(root: string, yamls: string[], read: ReadText): Promise<boolean> {
  const templates = path.join(root, 'templates') + path.sep;
  for (const file of yamls.filter((f) => f.startsWith(templates))) {
    const text = await read(file);
    if (KUBEMOOT_API.test(text) && CREW_TEMPLATE.test(text)) return true;
  }
  return false;
}

async function definesCrew(file: string, read: ReadText): Promise<boolean> {
  const text = await read(file);
  if (!KUBEMOOT_API.test(text) || !CREW_TEMPLATE.test(text)) return false;
  try {
    return crewOf(parseManifests(text)) !== undefined;
  } catch {
    return false;
  }
}

async function filterAsync<T>(items: T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const verdicts = await Promise.all(items.map(keep));
  return items.filter((_, i) => verdicts[i]);
}
