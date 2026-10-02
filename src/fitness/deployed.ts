import { checkName } from '../k8s/paths';
import type { KubeTransport } from '../k8s/request';
import { parseManifests, type Manifest } from '../source/manifests';
import { isScriptFile, scriptName } from '../source/scripts';
import { byCodeUnits } from '../text';
import { fitnessScenarioName } from './fitness';

/**
 * A crew deploys its fitness scenarios as ConfigMaps labeled with the crew and
 * `kubemoot.ai/fitness-kind=scenarios`, so a live crew carries its tests. A key ending in
 * .yaml holds CrewFitness or CrewFitnessSuite manifests; a key ending in .adl or .md
 * (other than README.md) holds one scenario script, named after the key.
 */
export const FITNESS_KIND_LABEL = 'kubemoot.ai/fitness-kind';
export const SCENARIOS_KIND = 'scenarios';

/** One scenario a live crew carries: its name, its script, and the ConfigMap it came from. */
export interface DeployedScenario {
  name: string;
  content: string;
  from: string;
}

interface ConfigMap {
  metadata: { name: string };
  data?: Record<string, string>;
}

type Script = { testRef?: unknown; testContent?: unknown };
type FitnessSpec = { crewRef?: unknown; testRef?: unknown; testContent?: unknown; scripts?: Script[] };

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The scripts of fitness manifests for a crew: each suite script, and each CrewFitness's own script. */
export function scriptsOf(manifests: Manifest[], crew: string): { name: string; content: string }[] {
  return manifests.flatMap((m) => {
    const spec = (m.spec ?? {}) as FitnessSpec;
    if (spec.crewRef !== undefined && spec.crewRef !== crew) return [];
    if (m.kind === 'CrewFitnessSuite') return (spec.scripts ?? []).flatMap((s) => (isText(s?.testRef) && isText(s.testContent) ? [{ name: s.testRef, content: s.testContent }] : []));
    if (m.kind === 'CrewFitness' && isText(spec.testContent)) return [{ name: fitnessScenarioName(m), content: spec.testContent }];
    return [];
  });
}

/** The scenarios in one ConfigMap key: the scripts of its manifests, or the key's own script. */
function scenariosInKey(key: string, text: string, crew: string): { name: string; content: string }[] {
  if (/\.ya?ml$/.test(key)) return scriptsOf(parseManifests(text), crew);
  if (isScriptFile(key)) return [{ name: scriptName(key), content: text }];
  return [];
}

/** Items by name, the first of each name kept, in their order: a crew runs one scenario of a name. */
export function uniqueByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.name) && seen.add(item.name));
}

/** The scenarios of one ConfigMap key, marked with where they came from; none for a key that does not parse. */
function scenariosFrom(cm: ConfigMap, key: string, text: string, crew: string): DeployedScenario[] {
  try {
    return scenariosInKey(key, text, crew).map((s) => ({ ...s, from: `${cm.metadata.name}/${key}` }));
  } catch {
    // A key that does not parse holds no scenario CrewForge can run.
    return [];
  }
}

/** The scenarios a crew's ConfigMaps hold, by name, the first of a name kept. */
export function scenariosIn(configMaps: ConfigMap[], crew: string): DeployedScenario[] {
  const all = configMaps.flatMap((cm) =>
    Object.entries(cm.data ?? {})
      .sort(([a], [b]) => byCodeUnits(a, b))
      .flatMap(([key, text]) => scenariosFrom(cm, key, text, crew)),
  );
  return uniqueByName(all).sort((a, b) => byCodeUnits(a.name, b.name));
}

/** The label selector of a crew's scenario ConfigMaps. */
export function scenariosSelector(crew: string): string {
  return `kubemoot.ai/crew=${crew},${FITNESS_KIND_LABEL}=${SCENARIOS_KIND}`;
}

/** The scenarios a live crew carries in its namespace. */
export async function readDeployedScenarios(client: KubeTransport, namespace: string, crew: string): Promise<DeployedScenario[]> {
  const url = `/api/v1/namespaces/${checkName('namespace', namespace)}/configmaps?labelSelector=${encodeURIComponent(scenariosSelector(crew))}`;
  const list = JSON.parse(await client.request('GET', url)) as { items?: ConfigMap[] };
  return scenariosIn(list.items ?? [], crew);
}

/** True when a source's scenarios differ from the deployed ones: another name, or another script. */
export function scenariosDiffer(deployed: DeployedScenario[], source: { name: string; content: string }[]): boolean {
  const want = new Map(source.map((s) => [s.name, s.content]));
  return want.size !== deployed.length || deployed.some((s) => want.get(s.name) !== s.content);
}
