import type { CrewDetails } from './details';

/** The groups a crew's objects are shown in, in both trees and on the crew dashboard, in this order. */
export const GROUP_ORDER = ['agents', 'prompts', 'skills', 'models', 'rag', 'mcp', 'tools', 'policies', 'notifications', 'fitness', 'deployment'] as const;

export type Group = (typeof GROUP_ORDER)[number];

export interface GroupInfo {
  label: string;
  icon: string;
  /** What the group holds and how an object comes to be in it, for the group's tooltip. */
  rule: string;
}

export const GROUPS: Record<Group, GroupInfo> = {
  agents: { label: 'Agents', icon: 'organization', rule: 'Agents labeled kubemoot.ai/crew with this crew.' },
  prompts: { label: 'Prompts', icon: 'note', rule: "PromptModules the agents name in spec.promptRefs, in the order the operator composes them." },
  skills: { label: 'Skills', icon: 'mortar-board', rule: 'Skills labeled kubemoot.ai/crew with this crew.' },
  models: {
    label: 'Models',
    icon: 'chip',
    rule: "Models in the crew's namespace, which the scheduler may bind its agents to by capability label, then the ModelProviders they run on (the crew's namespace, then kubemoot).",
  },
  rag: { label: 'RAG Sources', icon: 'book', rule: "RAGSources the agents or skills name (or were matched to by keyword) and the crew's own, then the EmbeddingModels they embed with." },
  mcp: {
    label: 'MCP Servers',
    icon: 'server-process',
    rule: "MCPServers the agents or skills name, installed with the crew, or registered with its gateway; then the namespace's MCPGateways and the quality policies, catalogs, and reports they use.",
  },
  tools: { label: 'Tools', icon: 'tools', rule: 'The MCP tools the agents enable in spec.enabledTools, with the MCP server that offers each.' },
  policies: { label: 'Policies', icon: 'law', rule: 'The CrewSchedulingPolicy whose crewRef names the crew, and the MootArchetype it runs.' },
  notifications: { label: 'Notifications', icon: 'bell', rule: "NotificationSinks in the crew's namespace that fire for its agents." },
  fitness: { label: 'Fitness', icon: 'beaker', rule: 'CrewFitnessSuites and CrewFitness runs whose crewRef names the crew.' },
  deployment: { label: 'Deployment', icon: 'package', rule: "How the crew was deployed, and the operator's defaults it runs with." },
};

/** Objects that are not the crew's own are marked so; a tooltip says who owns them. */
export const SHARED = 'shared';

/** The tooltip line of a shared object: who owns it, and that CrewForge only shows it. */
export function sharedLine(owner: string): string {
  return `Shared: owned by ${owner}. CrewForge shows it read-only.`;
}

/** How many objects a live crew has in each group; the deployment group always has its channel. */
export const COUNTS: Record<Group, (d: CrewDetails) => number> = {
  agents: (d) => d.agents.length,
  prompts: (d) => d.promptModules.length,
  skills: (d) => d.skills.length,
  models: (d) => d.related.models.length,
  rag: (d) => d.related.rag.length,
  mcp: (d) => d.mcpServers.length + d.related.mcp.length,
  tools: (d) => d.tools.length,
  policies: (d) => d.related.policies.length,
  notifications: (d) => d.related.notifications.length,
  fitness: (d) => d.related.fitness.length,
  deployment: () => 1,
};

/** One group and how many objects it holds, as the crew dashboard lists them. */
export interface GroupCount {
  group: Group;
  count: number;
}

/** Every group of a live crew with its count, in order. */
export function liveCounts(d: CrewDetails): GroupCount[] {
  return GROUP_ORDER.map((group) => ({ group, count: COUNTS[group](d) }));
}

/** True for the name of a group. */
export function isGroup(value: unknown): value is Group {
  return typeof value === 'string' && (GROUP_ORDER as readonly string[]).includes(value);
}
