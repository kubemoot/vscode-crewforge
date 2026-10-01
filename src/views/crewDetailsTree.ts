import * as vscode from 'vscode';
import { agentLine, agentTooltip, lines, missingPromptTooltip, promptLine, promptTooltip, usersText } from '../crew/describe';
import type { AgentInfo, CrewDetails, McpServerInfo, PromptModuleInfo, SkillInfo, ToolInfo } from '../crew/details';
import { COUNTS, GROUP_ORDER, GROUPS, SHARED, sharedLine, type Group } from '../crew/groups';
import { factsOf } from '../crew/kindFacts';
import type { Related } from '../crew/related';
import { parameters, toolOrigin, type ToolCatalog } from '../crew/toolCatalog';
import type { CrewSummary } from '../k8s/crews';
import { provenanceFacts, provenanceOf, type ProvenanceFact } from '../source/provenance';

/** A live object whose YAML can be opened: a Kubemoot object, or the Flux object that applies a crew. An empty namespace is a cluster-scoped object. */
export interface ObjectRef {
  kind: string;
  name: string;
  namespace: string;
}

export type Section = Group;

/** One leaf under a crew section. */
export interface MemberView {
  label: string;
  description?: string;
  tooltip: string;
  icon: string;
  color?: string;
  /** Set when the leaf is a live object; clicking it opens the object's YAML. */
  ref?: ObjectRef;
  /** Set on a tool; clicking it opens the tool's details. */
  tool?: { info: ToolInfo; catalog?: ToolCatalog };
  /** Set when the object is not the crew's own. */
  shared?: boolean;
}

export type DetailNode =
  | { kind: 'section'; crew: CrewSummary; section: Section; details: CrewDetails; catalog?: ToolCatalog }
  | { kind: 'member'; crew: CrewSummary; view: MemberView };

/** Every group under a crew, in order; a group with nothing in it says "none". */
export function sectionsOf(crew: CrewSummary, details: CrewDetails): DetailNode[] {
  return GROUP_ORDER.map((section) => ({ kind: 'section', crew, section, details }));
}

const MEMBERS: Record<Section, (crew: CrewSummary, d: CrewDetails, catalog?: ToolCatalog) => MemberView[]> = {
  agents: (crew, d) => d.agents.map((a) => agentView(crew, a)),
  prompts: (crew, d) => d.promptModules.map((m) => promptView(crew, m)),
  skills: (crew, d) => d.skills.map((s) => skillView(crew, s)),
  models: (_crew, d) => d.related.models.map(relatedView),
  rag: (_crew, d) => d.related.rag.map(relatedView),
  mcp: (crew, d) => [...d.mcpServers.map((s) => serverView(crew, s)), ...d.related.mcp.map(relatedView)],
  tools: (_crew, d, catalog) => d.tools.map((t) => toolView(t, catalog)),
  policies: (_crew, d) => d.related.policies.map(relatedView),
  notifications: (_crew, d) => d.related.notifications.map(relatedView),
  fitness: (_crew, d) => d.related.fitness.map(relatedView),
  deployment: (crew, d) => [...provenanceFacts(provenanceOf(crew)).map((f) => factView(crew, f)), ...d.related.operator.map(relatedView)],
};

export function membersOf(node: Extract<DetailNode, { kind: 'section' }>): DetailNode[] {
  return MEMBERS[node.section](node.crew, node.details, node.catalog).map((view) => ({ kind: 'member', crew: node.crew, view }));
}

function sectionSummary(section: Section, d: CrewDetails): string | undefined {
  if (section === 'deployment') return undefined;
  if (section === 'agents') return `${d.agents.filter((a) => a.ready).length} of ${d.agents.length} ready`;
  if (section === 'prompts') return `${d.promptModules.length}, ${d.promptModules.filter((m) => m.form === 'ADL').length} ADL`;
  return String(COUNTS[section](d));
}

export function sectionItem(node: Extract<DetailNode, { kind: 'section' }>): vscode.TreeItem {
  const { label, icon, rule } = GROUPS[node.section];
  const empty = COUNTS[node.section](node.details) === 0;
  const item = new vscode.TreeItem(label, empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `section:${node.crew.namespace}/${node.crew.name}:${node.section}`;
  item.description = empty ? 'none' : sectionSummary(node.section, node.details);
  item.tooltip = rule;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = `crewSection-${node.section}`;
  return item;
}

/** The context value of a leaf: a live object, a shared one, or a tool; none for a fact without an object. */
function memberContext(view: MemberView): string | undefined {
  if (view.tool) return 'tool';
  if (!view.ref) return undefined;
  return view.shared ? 'liveObject-shared' : 'liveObject';
}

export function memberItem(node: Extract<DetailNode, { kind: 'member' }>): vscode.TreeItem {
  const { view } = node;
  const item = new vscode.TreeItem(view.label, vscode.TreeItemCollapsibleState.None);
  item.description = view.description;
  item.tooltip = view.tooltip;
  item.iconPath = new vscode.ThemeIcon(view.icon, view.color ? new vscode.ThemeColor(view.color) : undefined);
  item.contextValue = memberContext(view);
  if (view.tool) item.command = { command: 'crewforge.showToolDetails', title: 'Show Tool Details', arguments: [node] };
  else if (view.ref) item.command = { command: 'crewforge.showLiveYaml', title: 'Show YAML', arguments: [node] };
  return item;
}

/** A related object: its facts, marked shared with its owner when it is not the crew's own; a missing one warns. */
export function relatedView(r: Related): MemberView {
  const facts = factsOf(r);
  const shared = r.sharedBy !== undefined;
  const state = facts.ready === undefined ? {} : readyIcon(facts.ready);
  const icon = r.object ? { icon: facts.icon, ...state } : { icon: 'warning', color: 'list.warningForeground' };
  return {
    label: r.name,
    description: [shared ? `${r.kind} · ${SHARED}` : r.kind, facts.description].filter(Boolean).join(' · '),
    tooltip: lines(`${r.kind} ${r.namespace ? r.namespace + '/' : ''}${r.name}`, `Why it is listed: ${r.reason}`, ...facts.lines, shared && sharedLine(r.sharedBy as string)),
    ...icon,
    ref: r.object ? { kind: r.kind, name: r.name, namespace: r.namespace ?? '' } : undefined,
    shared,
  };
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

/** A tool: the server it comes from, what it does, who enables it, and its inputs; a catalog that cannot be read is said on the item. */
export function toolView(t: ToolInfo, catalog?: ToolCatalog): MemberView {
  const { server } = toolOrigin(t, catalog);
  const from = server ? `from ${server}` : 'no server offers it';
  const unreadable = catalog?.unreadable ? 'catalog unreadable' : undefined;
  const warn = server ? {} : { color: 'list.warningForeground' };
  return {
    label: t.name,
    description: [from, t.agents.join(', '), unreadable].filter(Boolean).join(' · '),
    tooltip: toolTooltip(t, catalog),
    icon: server ? 'wrench' : 'warning',
    ...warn,
    tool: { info: t, catalog },
  };
}

function toolTooltip(t: ToolInfo, catalog?: ToolCatalog): string {
  const { server, description, schema } = toolOrigin(t, catalog);
  return lines(
    `Tool ${t.name}`,
    server ? `From: MCPServer ${server}` : 'No MCP server of this crew lists it.',
    description,
    `Enabled by: ${t.agents.join(', ')}`,
    schema && `Inputs: ${parameters(schema) || 'none'}`,
    catalog?.unreadable && `Cannot read the gateway's tool catalog: ${catalog.unreadable}`,
  );
}

/** A deployment fact; a Flux fact opens the Flux object, every other fact the Crew whose labels it came from. */
export function factView(crew: CrewSummary, f: ProvenanceFact): MemberView {
  const target = f.flux ? { kind: f.flux.kind, name: f.flux.name, namespace: f.flux.namespace } : ref(crew, 'Crew', crew.name);
  return { label: f.label, description: f.value, tooltip: `${f.label}: ${f.value}`, icon: f.flux ? 'git-merge' : 'tag', ref: target };
}
