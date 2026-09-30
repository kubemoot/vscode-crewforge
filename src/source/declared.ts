import { agentLine, agentTooltip, byName, lines, missingPromptTooltip, promptLine, promptTooltip, text, usersText } from '../crew/describe';
import { promptModulesOf, serverRefs, toAgent, toPromptModule, toSkill, type AgentInfo, type PromptModuleInfo } from '../crew/details';
import { isFitness } from '../fitness/fitness';
import { scenarioLine, type Located } from './locate';
import { crewOf, isKubemoot, type Manifest } from './manifests';

/** The groups a crew source's declarations appear in, in tree order. */
export type DeclaredSection = 'agents' | 'prompts' | 'skills' | 'mcp' | 'fitness';

/** One thing a source declares, ready to show, and where it starts in its file. */
export interface DeclaredItem {
  label: string;
  description?: string;
  tooltip: string;
  icon: string;
  /** A warning color for something named but not declared. */
  warn?: boolean;
  file?: string;
  line: number;
}

export interface Declarations {
  crew?: DeclaredItem;
  sections: { section: DeclaredSection; items: DeclaredItem[] }[];
}

type Obj = Manifest & { spec?: Record<string, unknown> };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * What a crew source declares, read from its rendered objects: the Crew, its Agents
 * (role, capabilities), the PromptModules they compose (ADL or prose), Skills, MCP
 * servers, and fitness scenarios. `fitness` holds the fitness definitions found beside
 * the chart as well as the rendered ones; `readText` finds each scenario's line.
 */
export async function declarationsOf(located: Located[], fitness: Located[], readText: (file: string) => Promise<string>): Promise<Declarations> {
  const where = new Map(located.map((l) => [l.manifest, l]));
  const at = (m?: Manifest): Pick<DeclaredItem, 'file' | 'line'> => {
    const l = m && where.get(m);
    return { file: l?.file, line: l?.line ?? 0 };
  };
  const ofKind = (kind: string) => locatedOfKind(located, kind).map((l) => l.manifest as Obj);
  const crew = crewOf(located.map((l) => l.manifest));
  const agents = ofKind('Agent').map(toAgent).sort(byName);
  const skills = ofKind('Skill').map(toSkill).sort((a, b) => a.order - b.order || byName(a, b));
  return {
    crew: crew && { label: crew.metadata.name, description: 'Crew', tooltip: lines(`Crew ${crew.metadata.name}`, text((crew as Obj).spec?.description)), icon: 'organization', ...at(crew) },
    sections: [
      { section: 'agents', items: agents.map((a) => ({ ...agentItem(a), ...at(a.object) })) },
      { section: 'prompts', items: promptsOf(agents, ofKind('PromptModule')).map((m) => ({ ...promptItem(m), ...at(m.object) })) },
      { section: 'skills', items: skills.map((s) => ({ label: s.name, description: `order ${s.order}`, tooltip: lines(`Skill ${s.name}`, `Order: ${s.order}`, s.description), icon: 'mortar-board', ...at(s.object) })) },
      { section: 'mcp', items: serversOf([...agents.map((a) => a.object as Obj), ...skills.map((s) => s.object as Obj)], ofKind('MCPServer'), at) },
      { section: 'fitness', items: await scenariosOf(fitness, readText) },
    ],
  };
}


function agentItem(a: AgentInfo): Omit<DeclaredItem, 'line'> {
  return {
    label: a.name,
    description: agentLine(a),
    tooltip: agentTooltip(a),
    icon: 'person',
  };
}

/** The PromptModules the agents compose, in composition order, then any the source declares that no agent composes. */
function promptsOf(agents: AgentInfo[], modules: Obj[]): PromptModuleInfo[] {
  const composed = promptModulesOf(agents, modules);
  const named = new Set(composed.map((m) => m.name));
  const unused = modules.filter((m) => !named.has(m.metadata.name)).map((m) => toPromptModule(m.metadata.name, [], m));
  return [...composed, ...unused];
}

function promptItem(m: PromptModuleInfo): Omit<DeclaredItem, 'line'> {
  if (!m.object) {
    return { label: m.name, description: `not in this source · ${usersText(m)}`, tooltip: missingPromptTooltip(m, 'this source does not declare it'), icon: 'warning', warn: true };
  }
  return { label: m.name, description: promptLine(m), tooltip: promptTooltip(m), icon: m.form === 'ADL' ? 'symbol-structure' : 'symbol-text' };
}

/** The MCPServers the source declares, then those its agents or skills name that it does not. */
function serversOf(members: Obj[], servers: Obj[], at: (m?: Manifest) => Pick<DeclaredItem, 'file' | 'line'>): DeclaredItem[] {
  const named = new Set(members.flatMap(serverRefs));
  const declared = servers.map((s): DeclaredItem => {
    const reason = named.has(s.metadata.name) ? 'declared here, named by an agent or skill' : 'declared here';
    return { label: s.metadata.name, description: reason, tooltip: `MCPServer ${s.metadata.name}: ${reason}`, icon: 'server-process', ...at(s) };
  });
  const have = new Set(servers.map((s) => s.metadata.name));
  const elsewhere = [...named].filter((n) => !have.has(n)).map((n): DeclaredItem => ({ label: n, description: 'named, installed elsewhere', tooltip: `MCPServer ${n} is named by an agent or skill; this source does not install it.`, icon: 'server-process', line: 0 }));
  return [...declared, ...elsewhere].sort((a, b) => a.label.localeCompare(b.label));
}

/** Each scenario of each fitness definition: a suite's scripts by testRef, or a CrewFitness itself. */
async function scenariosOf(fitness: Located[], readText: (file: string) => Promise<string>): Promise<DeclaredItem[]> {
  const items = await Promise.all(fitness.filter((l) => isFitness(l.manifest)).map((l) => scenariosIn(l, readText)));
  return items.flat();
}

async function scenariosIn(l: Located, readText: (file: string) => Promise<string>): Promise<DeclaredItem[]> {
  const m = l.manifest as Obj;
  const scripts = Array.isArray(m.spec?.scripts) ? (m.spec.scripts as { testRef?: unknown }[]) : [];
  const refs = scripts.map((s) => s?.testRef).filter((r): r is string => typeof r === 'string');
  if (m.kind !== 'CrewFitnessSuite' || refs.length === 0) {
    return [{ label: m.metadata.name, description: m.kind, tooltip: `${m.kind} ${m.metadata.name}`, icon: 'beaker', file: l.file, line: l.line }];
  }
  const body = l.file ? await readText(l.file).catch(() => '') : '';
  return refs.map((ref) => ({ label: ref, description: `suite ${m.metadata.name}`, tooltip: lines(`Scenario ${ref} of CrewFitnessSuite ${m.metadata.name}`, text(m.spec?.description)), icon: 'beaker', file: l.file, line: scenarioLine(body, l.line, ref) }));
}

/** The Kubemoot objects of one kind among located ones. */
function locatedOfKind(located: Located[], kind: string): Located[] {
  return located.filter((l) => l.manifest.kind === kind && isKubemoot(l.manifest));
}

/** Where an agent is defined, then the PromptModules it composes in the order the operator composes them, for jumping from a chat to its source. */
export function agentPrompts(located: Located[], agent: string): Located[] {
  const agentObject = locatedOfKind(located, 'Agent').find((l) => l.manifest.metadata.name === agent);
  if (!agentObject) return [];
  const refs = strings((agentObject.manifest as Obj).spec?.promptRefs);
  const modules = locatedOfKind(located, 'PromptModule').filter((l) => refs.includes(l.manifest.metadata.name));
  return [agentObject, ...modules.sort((a, b) => orderOf(a) - orderOf(b) || a.manifest.metadata.name.localeCompare(b.manifest.metadata.name))];
}

const orderOf = (l: Located): number => toPromptModule(l.manifest.metadata.name, [], l.manifest as Obj).order;

/** Each agent a source declares, with where it and its PromptModules are defined. */
export function agentSourceMap(located: Located[]): Map<string, Located[]> {
  const agents = locatedOfKind(located, 'Agent').map((l) => l.manifest.metadata.name);
  return new Map(agents.map((name) => [name, agentPrompts(located, name)]));
}
