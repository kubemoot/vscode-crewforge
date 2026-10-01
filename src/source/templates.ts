import { CREW_LABEL } from '../crew/related';
import { splitList } from '../crew/values';

/**
 * How a new object is written into a source, so it looks like the objects already there:
 * a kmctl chart writes plain YAML labeled with the crew; a chart with a common-labels
 * helper (as the Pilot chart has) includes it and places the object in the release
 * namespace; a bundle names the namespace its Crew names.
 */
export interface SourceStyle {
  kind: 'helm' | 'bundle';
  crew: string;
  /** The chart helper that renders its common labels, such as `homelab-pilot-crew.labels`. */
  labelsHelper?: string;
  /** For a bundle: the namespace its Crew names. */
  namespace?: string;
}

/** The answers to a kind's questions, by key: text, or a list for a multiple choice. */
export type Answers = Record<string, string | string[]>;

/** The labels helper a chart's `_helpers.tpl` defines, if any: a `define "<name>.labels"`. */
export function labelsHelperIn(helpers: string): string | undefined {
  return /define\s+"([\w.-]+\.labels)"/.exec(helpers)?.[1];
}

const one = (a: Answers, key: string): string => {
  const v = a[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};
const many = (a: Answers, key: string): string[] => {
  const v = a[key];
  if (Array.isArray(v)) return v;
  return splitList(v ?? '');
};

/** A YAML double-quoted string: JSON's string syntax is valid YAML. */
export const quoted = (s: string): string => JSON.stringify(s);

/** A flow list of plain tokens: `[a, b]`. */
const flow = (items: string[]): string => `[${items.join(', ')}]`;

/** A block of text under `content: |`, indented for a spec field. */
const block = (lines: string[]): string[] => lines.map((l) => (l ? `    ${l}` : ''));

/** The head of an object: apiVersion, kind, and metadata with its name, namespace, and labels. */
export function head(style: SourceStyle, kind: string, name: string, extraLabels: Record<string, string> = {}): string[] {
  const out = ['apiVersion: kubemoot.ai/v1alpha1', `kind: ${kind}`, 'metadata:', `  name: ${name}`];
  if (style.kind === 'helm' && style.labelsHelper) out.push('  namespace: {{ .Release.Namespace }}');
  if (style.kind === 'bundle' && style.namespace) out.push(`  namespace: ${style.namespace}`);
  out.push('  labels:');
  if (style.kind === 'helm' && style.labelsHelper) out.push(`    {{- include ${quoted(style.labelsHelper)} . | nindent 4 }}`);
  out.push(`    ${CREW_LABEL}: ${style.crew}`);
  for (const [k, v] of Object.entries(extraLabels)) out.push(`    ${k}: ${quoted(v)}`);
  return out;
}

/** An Agent in the shape of the kmctl scaffold's agents: role, capabilities, PromptModules, and tools. */
export function agentYaml(style: SourceStyle, a: Answers): string {
  const name = one(a, 'name');
  const role = one(a, 'role');
  const tools = many(a, 'tools');
  return [
    ...head(style, 'Agent', name, { 'kubemoot.ai/role': role }),
    'spec:',
    '  type: chat',
    `  description: ${quoted(role + ' ' + name + ' - replace with a real responsibility.')}`,
    `  discussRole: ${role}`,
    `  capabilities: ${flow(many(a, 'capabilities'))}`,
    '  discussChannels: [general]',
    `  promptRefs: ${flow(many(a, 'promptRefs'))}`,
    ...(tools.length ? [`  enabledTools: ${flow(tools)}`] : []),
    `  temperature: ${quoted(role === 'coordinator' ? '0.1' : '0.3')}`,
    '  maxTokens: 4096',
    '  deployment:',
    '    replicas: 1',
    '    port: 8080',
    '',
  ].join('\n');
}

/** The starting text of a PromptModule: ADL statements, or plain prose. */
export function promptContent(name: string, form: string): string[] {
  if (form === 'prose') return ['Describe, in plain sentences, what the agents that compose this module should do and never do.'];
  return [`DEFINE DOMAIN ${name}`, 'DESCRIPTION What this module tells the agents - replace this', '', 'ALWAYS state one rule the agents must follow', 'NEVER state one thing the agents must not do'];
}

export function promptModuleYaml(style: SourceStyle, a: Answers): string {
  const name = one(a, 'name');
  return [...head(style, 'PromptModule', name), 'spec:', `  order: ${Number(one(a, 'order'))}`, '  content: |', ...block(promptContent(name, one(a, 'form'))), ''].join('\n');
}

export function skillYaml(style: SourceStyle, a: Answers): string {
  const name = one(a, 'name');
  const description = one(a, 'description');
  return [
    ...head(style, 'Skill', name),
    'spec:',
    `  description: ${quoted(description)}`,
    `  order: ${Number(one(a, 'order'))}`,
    '  content: |',
    ...block([`DEFINE COMPONENT ${name}`, `DESCRIPTION ${description}`, '', 'WHEN the situation this skill handles arises THEN take the first step', 'ASSERT what must hold when the procedure is done']),
    '',
  ].join('\n');
}

export function mcpServerYaml(style: SourceStyle, a: Answers): string {
  const where = one(a, 'where');
  const spec = one(a, 'from') === 'endpoint' ? [`  externalEndpoint: ${quoted(where)}`, '  transport: http'] : [`  image: ${quoted(where)}`, '  transport: http', '  port: 3000', '  replicas: 1'];
  return [...head(style, 'MCPServer', one(a, 'name')), 'spec:', ...spec, ''].join('\n');
}

/** A vector store collection name: the source's name with underscores, which every store accepts. */
export const collectionOf = (name: string): string => name.replaceAll('-', '_');

export function ragSourceYaml(style: SourceStyle, a: Answers): string {
  const name = one(a, 'name');
  return [
    ...head(style, 'RAGSource', name),
    'spec:',
    '  source:',
    '    type: git',
    '    git:',
    `      url: ${quoted(one(a, 'url'))}`,
    `      branch: ${quoted(one(a, 'branch'))}`,
    '      paths:',
    ...many(a, 'paths').map((p) => `        - ${quoted(p)}`),
    `  embeddingModelRef: ${one(a, 'embeddingModel')}`,
    '  vectorStore:',
    '    type: pgvector',
    `    endpoint: ${quoted(one(a, 'endpoint'))}`,
    `    collection: ${collectionOf(name)}`,
    '  chunking:',
    '    chunkSize: 512',
    '    chunkOverlap: 50',
    '',
  ].join('\n');
}

export function embeddingModelYaml(style: SourceStyle, a: Answers): string {
  return [...head(style, 'EmbeddingModel', one(a, 'name')), 'spec:', `  model: ${quoted(one(a, 'model'))}`, `  providerRef: ${one(a, 'provider')}`, `  dimensions: ${Number(one(a, 'dimensions'))}`, ''].join('\n');
}

/** A Model labeled the way the scheduler selects Models: capability labels, a latency class, and a context window. */
export function modelYaml(style: SourceStyle, a: Answers): string {
  const labels: Record<string, string> = { latencyClass: one(a, 'latencyClass') };
  const context = one(a, 'contextWindow');
  if (context) labels.contextWindow = context;
  for (const cap of many(a, 'capabilities')) labels[`capability/${cap}`] = 'true';
  return [...head(style, 'Model', one(a, 'name'), labels), 'spec:', `  model: ${quoted(one(a, 'model'))}`, `  providerRef: ${quoted(one(a, 'provider'))}`, ''].join('\n');
}

/** A CrewSchedulingPolicy in the shape of the kmctl scaffold's: a quality bias per capability, and tool-calling Models for mulling and triage. */
export function schedulingPolicyYaml(style: SourceStyle, a: Answers): string {
  return [
    ...head(style, 'CrewSchedulingPolicy', one(a, 'name')),
    'spec:',
    `  crewRef: ${quoted(style.crew)}`,
    `  archetypeRef: ${one(a, 'archetype')}`,
    '  # Per-capability quality bias in [0,1]: lower -> speed-lean, higher -> quality-lean.',
    '  qualityBias:',
    '    reasoning: "0.7"',
    '    tool-calling: "0.3"',
    '    default: "0.4"',
    '  rules:',
    '    - phase: mulling',
    '      require:',
    '        matchLabels:',
    '          capability/tool-calling: "true"',
    '    - phase: triage',
    '      require:',
    '        matchLabels:',
    '          capability/tool-calling: "true"',
    '',
  ].join('\n');
}

export function notificationSinkYaml(style: SourceStyle, a: Answers): string {
  return [...head(style, 'NotificationSink', one(a, 'name')), 'spec:', '  webhook:', `    url: ${quoted(one(a, 'url'))}`, '    method: POST', '  priority: default', ''].join('\n');
}
