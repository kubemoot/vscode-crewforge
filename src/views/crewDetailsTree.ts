import * as vscode from 'vscode';
import { agentLine, agentTooltip, lines, missingPromptTooltip, promptLine, promptTooltip, usersText } from '../crew/describe';
import type { AgentInfo, CrewDetails, McpServerInfo, PromptModuleInfo, SkillInfo, ToolInfo } from '../crew/details';
import type { CrewSummary } from '../k8s/crews';
import { provenanceFacts, provenanceOf, type ProvenanceFact } from '../source/provenance';

/** A live object whose YAML can be opened: a Kubemoot object, or the Flux object that applies a crew. */
export interface ObjectRef {
  kind: string;
  name: string;
  namespace: string;
}

export type Section = 'agents' | 'prompts' | 'skills' | 'mcp' | 'tools' | 'deployment';

/** One leaf under a crew section. */
export interface MemberView {
  label: string;
  description?: string;
  tooltip: string;
  icon: string;
  color?: string;
  /** Set when the leaf is a live object; clicking it opens the object's YAML. */
  ref?: ObjectRef;
}

export type DetailNode =
  | { kind: 'section'; crew: CrewSummary; section: Section; details: CrewDetails }
  | { kind: 'member'; crew: CrewSummary; view: MemberView };

const SECTION_TITLES: Record<Section, [string, string]> = {
  agents: ['Agents', 'organization'],
  prompts: ['PromptModules', 'note'],
  skills: ['Skills', 'mortar-board'],
  mcp: ['MCP Servers', 'server-process'],
  tools: ['Tools', 'tools'],
  deployment: ['Deployment', 'package'],
};

/** The sections under a crew; MCP servers and tools appear only when the crew has some. */
export function sectionsOf(crew: CrewSummary, details: CrewDetails): DetailNode[] {
  const sections: Section[] = ['agents', 'prompts', 'skills'];
  if (details.mcpServers.length) sections.push('mcp');
  if (details.tools.length) sections.push('tools');
  sections.push('deployment');
  return sections.map((section) => ({ kind: 'section', crew, section, details }));
}

const MEMBERS: Record<Section, (crew: CrewSummary, d: CrewDetails) => MemberView[]> = {
  agents: (crew, d) => d.agents.map((a) => agentView(crew, a)),
  prompts: (crew, d) => d.promptModules.map((m) => promptView(crew, m)),
  skills: (crew, d) => d.skills.map((s) => skillView(crew, s)),
  mcp: (crew, d) => d.mcpServers.map((s) => serverView(crew, s)),
  tools: (_crew, d) => d.tools.map(toolView),
  deployment: (crew) => provenanceFacts(provenanceOf(crew)).map((f) => factView(crew, f)),
};

export function membersOf(node: Extract<DetailNode, { kind: 'section' }>): DetailNode[] {
  return MEMBERS[node.section](node.crew, node.details).map((view) => ({ kind: 'member', crew: node.crew, view }));
}

/** How many members a section has; the deployment section always has its channel. */
const COUNTS: Record<Section, (d: CrewDetails) => number> = {
  agents: (d) => d.agents.length,
  prompts: (d) => d.promptModules.length,
  skills: (d) => d.skills.length,
  mcp: (d) => d.mcpServers.length,
  tools: (d) => d.tools.length,
  deployment: () => 1,
};

function sectionSummary(section: Section, d: CrewDetails): string | undefined {
  if (section === 'deployment') return undefined;
  if (section === 'agents') return `${d.agents.filter((a) => a.ready).length} of ${d.agents.length} ready`;
  if (section === 'prompts') return `${d.promptModules.length}, ${d.promptModules.filter((m) => m.form === 'ADL').length} ADL`;
  return String(COUNTS[section](d));
}

export function sectionItem(node: Extract<DetailNode, { kind: 'section' }>): vscode.TreeItem {
  const [title, icon] = SECTION_TITLES[node.section];
  const empty = COUNTS[node.section](node.details) === 0;
  const item = new vscode.TreeItem(title, empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
  item.description = empty ? 'none' : sectionSummary(node.section, node.details);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = `crewSection-${node.section}`;
  return item;
}

export function memberItem(node: Extract<DetailNode, { kind: 'member' }>): vscode.TreeItem {
  const { view } = node;
  const item = new vscode.TreeItem(view.label, vscode.TreeItemCollapsibleState.None);
  item.description = view.description;
  item.tooltip = view.tooltip;
  item.iconPath = new vscode.ThemeIcon(view.icon, view.color ? new vscode.ThemeColor(view.color) : undefined);
  if (view.ref) {
    item.contextValue = 'liveObject';
    item.command = { command: 'crewforge.showLiveYaml', title: 'Show YAML', arguments: [node] };
  }
  return item;
}

const ref = (crew: CrewSummary, kind: string, name: string): ObjectRef => ({ kind, name, namespace: crew.namespace });
/** The mark of a ready thing, and of one that is not ready yet: crews, agents, MCP servers. */
export const readyIcon = (ready?: boolean): Pick<MemberView, 'icon' | 'color'> =>
  ready ? { icon: 'pass-filled', color: 'testing.iconPassed' } : { icon: 'circle-large-outline', color: 'list.warningForeground' };

export function agentView(crew: CrewSummary, a: AgentInfo): MemberView {
  const state = a.ready ? 'ready' : (a.phase ?? 'not ready');
  const shownState = a.ready ? '' : ` · ${state}`;
  return {
    label: a.name,
    description: `${agentLine(a)}${shownState}`,
    tooltip: agentTooltip(a, state),
    ...readyIcon(a.ready),
    ref: ref(crew, 'Agent', a.name),
  };
}

export function promptView(crew: CrewSummary, m: PromptModuleInfo): MemberView {
  const users = usersText(m);
  if (!m.object) {
    return { label: m.name, description: `missing · ${users}`, tooltip: missingPromptTooltip(m, 'does not exist'), icon: 'warning', color: 'list.warningForeground' };
  }
  return {
    label: m.name,
    description: promptLine(m),
    tooltip: promptTooltip(m, m.shared && 'Agents outside this crew compose it too.'),
    icon: m.form === 'ADL' ? 'symbol-structure' : 'symbol-text',
    ref: ref(crew, 'PromptModule', m.name),
  };
}

export function skillView(crew: CrewSummary, s: SkillInfo): MemberView {
  return {
    label: s.name,
    description: `order ${s.order}${s.ready === false ? ' · not ready' : ''}`,
    tooltip: lines(`Skill ${s.name}`, `Order: ${s.order}`, s.description),
    icon: s.ready === false ? 'warning' : 'mortar-board',
    ref: ref(crew, 'Skill', s.name),
  };
}

/** "ready" or "not ready"; undefined when readiness is not known. */
function readyWord(ready: boolean | undefined): string | undefined {
  if (ready === undefined) return undefined;
  return ready ? 'ready' : 'not ready';
}

export function serverView(crew: CrewSummary, s: McpServerInfo): MemberView {
  if (!s.object) return { label: s.name, description: 'missing', tooltip: `MCPServer ${s.name}: ${s.reason}.`, icon: 'warning', color: 'list.warningForeground' };
  const tools = s.toolCount === undefined ? undefined : `${s.toolCount} tools`;
  const state = readyWord(s.ready);
  return {
    label: s.name,
    description: [state, tools].filter(Boolean).join(' · ') || undefined,
    tooltip: lines(`MCPServer ${s.name}`, `Why it is listed: ${s.reason}`, state && `State: ${state}`, tools),
    ...readyIcon(s.ready),
    ref: ref(crew, 'MCPServer', s.name),
  };
}

export function toolView(t: ToolInfo): MemberView {
  return { label: t.name, description: t.agents.join(', '), tooltip: `Tool ${t.name}, enabled for: ${t.agents.join(', ')}`, icon: 'wrench' };
}

/** A deployment fact; a Flux fact opens the Flux object, every other fact the Crew whose labels it came from. */
export function factView(crew: CrewSummary, f: ProvenanceFact): MemberView {
  const target = f.flux ? { kind: f.flux.kind, name: f.flux.name, namespace: f.flux.namespace } : ref(crew, 'Crew', crew.name);
  return { label: f.label, description: f.value, tooltip: `${f.label}: ${f.value}`, icon: f.flux ? 'git-merge' : 'tag', ref: target };
}
