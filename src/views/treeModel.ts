import type { CrewCondition, CrewSummary } from '../k8s/crews';
import { provenanceOf } from '../source/provenance';

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

/** The one line under a crew's name in the tree: phase, agents, and chart version. */
export function crewDescription(crew: CrewSummary): string {
  const version = provenanceOf(crew).chartVersion;
  const parts = [crew.phase];
  if (crew.agents !== undefined) parts.push(agentCount(crew.agents));
  if (version) parts.push(version.startsWith('v') ? version : `v${version}`);
  return parts.join(', ');
}

/** "1 agent", "3 agents". */
export function agentCount(n: number): string {
  return n === 1 ? '1 agent' : `${n} agents`;
}

/** The hover text of a crew: its state, then its metadata; the archetype comes from its CrewSchedulingPolicy once known. */
export function crewTooltip(crew: CrewSummary, archetype?: string): string {
  const lines = [`${crew.namespace}/${crew.name}`, `Phase: ${crew.phase}${crew.ready ? ' (ready)' : ''}`];
  if (crew.coordinator) lines.push(`Coordinator: ${crew.coordinator}`);
  if (crew.message) lines.push(crew.message);
  if (crew.description) lines.push(`Description: ${crew.description}`);
  lines.push(`Namespace: ${crew.namespace}`);
  if (crew.created) lines.push(`Created: ${crew.created}`);
  if (archetype) lines.push(`Archetype: ${archetype}`);
  return [...lines, ...mapLines('Labels', crew.labels), ...conditionLines(crew.conditions)].join('\n');
}

function mapLines(title: string, map: Record<string, string> = {}): string[] {
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? [`${title}:`, ...entries.map(([k, v]) => `  ${k}=${v}`)] : [];
}

function conditionLines(conditions: CrewCondition[] = []): string[] {
  if (conditions.length === 0) return [];
  return ['Conditions:', ...conditions.map(conditionLine)];
}

function conditionLine(c: CrewCondition): string {
  const reason = c.reason ? ` (${c.reason})` : '';
  const message = c.message ? `: ${c.message}` : '';
  return `  ${c.type}=${c.status}${reason}${message}`;
}

/** The empty state's line about a crew. */
export function crewAbout(crew: CrewSummary): string {
  const parts: string[] = [];
  if (crew.agents !== undefined) parts.push(agentCount(crew.agents));
  if (crew.coordinator) parts.push(`coordinator ${crew.coordinator}`);
  if (!crew.ready) parts.push(`phase ${crew.phase}: it may not answer yet`);
  return parts.join(', ');
}
