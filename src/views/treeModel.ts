import type { CrewSummary } from '../k8s/crews';

export interface NamespaceGroup {
  namespace: string;
  crews: CrewSummary[];
}

/** Groups crews by namespace, namespaces and crews in name order. */
export function groupByNamespace(crews: CrewSummary[]): NamespaceGroup[] {
  const groups = new Map<string, CrewSummary[]>();
  for (const crew of crews) {
    const list = groups.get(crew.namespace) ?? [];
    list.push(crew);
    groups.set(crew.namespace, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, list]) => ({ namespace, crews: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** The one line under a crew's name in the tree. */
export function crewDescription(crew: CrewSummary): string {
  const agents = crew.agents === undefined ? '' : `, ${agentCount(crew.agents)}`;
  return `${crew.phase}${agents}`;
}

/** "1 agent", "3 agents". */
export function agentCount(n: number): string {
  return n === 1 ? '1 agent' : `${n} agents`;
}

/** The hover text of a crew. */
export function crewTooltip(crew: CrewSummary): string {
  const lines = [`${crew.namespace}/${crew.name}`, `Phase: ${crew.phase}${crew.ready ? ' (ready)' : ''}`];
  if (crew.coordinator) lines.push(`Coordinator: ${crew.coordinator}`);
  if (crew.message) lines.push(crew.message);
  return lines.join('\n');
}

/** The empty state's line about a crew. */
export function crewAbout(crew: CrewSummary): string {
  const parts: string[] = [];
  if (crew.agents !== undefined) parts.push(agentCount(crew.agents));
  if (crew.coordinator) parts.push(`coordinator ${crew.coordinator}`);
  if (!crew.ready) parts.push(`phase ${crew.phase}: it may not answer yet`);
  return parts.join(', ');
}
