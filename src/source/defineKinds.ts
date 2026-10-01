import { nameProblem } from '../k8s/paths';
import { byCodeUnits } from '../text';
import { specOf, splitList, strings } from '../crew/values';
import { DEFAULT_ARCHETYPE } from '../crew/related';
import type { DeclaredSection } from './declared';
import type { Manifest } from './manifests';
import {
  agentYaml,
  embeddingModelYaml,
  mcpServerYaml,
  modelYaml,
  notificationSinkYaml,
  promptModuleYaml,
  ragSourceYaml,
  schedulingPolicyYaml,
  skillYaml,
  type Answers,
  type SourceStyle,
} from './templates';

/** What the questions of a new object can see: the crew, and the Kubemoot objects its source renders. */
export interface DefineContext {
  crew: string;
  objects: Manifest[];
}

type Check = (value: string, context: DefineContext) => string | undefined;

export interface PickItem {
  label: string;
  description?: string;
  value: string;
}

/** One question asked before a new object is written: a line of text, one choice, or several. */
export type Question =
  | { key: string; type: 'text'; title: string; prompt: string | ((c: DefineContext) => string); value?: (c: DefineContext) => string; check: Check }
  | { key: string; type: 'pick'; title: string; items: (c: DefineContext) => PickItem[] }
  | { key: string; type: 'pickMany'; title: string; items: (c: DefineContext) => string[] };

/** A kind that "Add <Kind>..." creates: the group it is added from, its questions, and the YAML it writes. */
export interface KindDefinition {
  kind: string;
  section: DeclaredSection;
  questions: Question[];
  yaml: (style: SourceStyle, answers: Answers) => string;
  /** Why the kind cannot be added to this source now, such as a second scheduling policy. */
  refuse?: (c: DefineContext) => string | undefined;
}

const ofKind = (c: DefineContext, kind: string) => c.objects.filter((m) => m.kind === kind);
const names = (c: DefineContext, kind: string) => ofKind(c, kind).map((m) => m.metadata.name);
/** A string field of the first object of a kind that has it, as a default that matches what the source already uses. */
const firstField = (c: DefineContext, kind: string, read: (s: Record<string, unknown>) => unknown): string | undefined =>
  ofKind(c, kind)
    .map((m) => read(specOf(m)))
    .find((v): v is string => typeof v === 'string' && v !== '');

/** A text that a Helm template would not read as an expression, and that fits on one line. */
export function plainText(what: string, optional = false): Check {
  return (v) => {
    if (!v.trim()) return optional ? undefined : `Enter ${what}.`;
    if (v.includes('{{') || /[\n\r]/.test(v)) return `${what} cannot hold "{{" or a line break.`;
    return undefined;
  };
}

/** A comma-separated list of tokens such as capability or tool names: letters, digits, dots, slashes, underscores, hyphens. */
export function tokenList(what: string, optional = false): Check {
  return (v) => {
    const items = splitList(v);
    if (items.length === 0) return optional ? undefined : `Enter at least one ${what}.`;
    const bad = items.find((x) => !/^[A-Za-z0-9][\w./-]*$/.test(x));
    return bad ? `"${bad}" is not a valid ${what}: use letters, digits, ".", "/", "_", or "-".` : undefined;
  };
}

/** A whole number in a range. */
export function wholeNumber(what: string, max: number, optional = false): Check {
  return (v) => {
    if (!v.trim() && optional) return undefined;
    return /^\d+$/.test(v.trim()) && Number(v) <= max ? undefined : `${what} is a whole number from 0 to ${max}.`;
  };
}

/** A new object's name: a valid Kubernetes name that no object of the kind in the source has. */
export function newName(kind: string): Check {
  return (v, c) => nameProblem(kind, v) ?? (names(c, kind).includes(v.trim()) ? `The source already declares ${kind} ${v.trim()}.` : undefined);
}

const nameQuestion = (kind: string, value?: (c: DefineContext) => string): Question => ({ key: 'name', type: 'text', title: `New ${kind}`, prompt: `The ${kind}'s name: lowercase letters, digits, and hyphens.`, value, check: newName(kind) });

const ROLES: PickItem[] = [
  { label: 'tooler', description: 'calls MCP tools and reports what it finds', value: 'tooler' },
  { label: 'researcher', description: 'gives advisory input; does not settle a discussion', value: 'researcher' },
  { label: 'analyst', description: 'reasons over what the toolers gathered', value: 'analyst' },
  { label: 'coordinator', description: 'runs the discussion and writes the answer', value: 'coordinator' },
];

/** The tools the source's agents already enable, as choices for a new agent. */
const knownTools = (c: DefineContext): string[] => [...new Set(ofKind(c, 'Agent').flatMap((a) => strings(specOf(a).enabledTools)))].sort(byCodeUnits);

/** The tools question's prompt, with the tools the other agents enable as examples. */
export function toolsPrompt(c: DefineContext): string {
  const known = knownTools(c);
  const examples = known.length ? ` The other agents enable: ${known.join(', ')}.` : '';
  return `The MCP tools the agent may call, comma-separated; empty for none.${examples}`;
}

const AGENT: KindDefinition = {
  kind: 'Agent',
  section: 'agents',
  questions: [
    nameQuestion('Agent'),
    { key: 'role', type: 'pick', title: "The agent's discussion role", items: () => ROLES },
    { key: 'capabilities', type: 'text', title: 'Capabilities', prompt: 'What the agent asks the scheduler for, comma-separated; never a model name. Example: tool-calling, kubernetes', value: () => 'tool-calling', check: tokenList('capability') },
    { key: 'promptRefs', type: 'pickMany', title: 'PromptModules the agent composes', items: (c) => names(c, 'PromptModule').sort(byCodeUnits) },
    { key: 'tools', type: 'text', title: 'Tools', prompt: toolsPrompt, value: () => '', check: tokenList('tool name', true) },
  ],
  yaml: agentYaml,
};

const PROMPT: KindDefinition = {
  kind: 'PromptModule',
  section: 'prompts',
  questions: [
    nameQuestion('PromptModule'),
    {
      key: 'form',
      type: 'pick',
      title: 'ADL or prose?',
      items: () => [
        { label: 'ADL', description: 'DEFINE, DESCRIPTION, ALWAYS, NEVER, WHEN ... THEN statements', value: 'ADL' },
        { label: 'Prose', description: 'plain sentences', value: 'prose' },
      ],
    },
    { key: 'order', type: 'text', title: 'Order', prompt: 'Where the module goes when an agent composes several: lower comes first.', value: () => '100', check: wholeNumber('The order', 10000) },
  ],
  yaml: promptModuleYaml,
};

const SKILL: KindDefinition = {
  kind: 'Skill',
  section: 'skills',
  questions: [
    nameQuestion('Skill'),
    { key: 'description', type: 'text', title: 'When it applies', prompt: 'What the skill does and when it applies; the coordinator reads this to pick it.', check: plainText('a description') },
    { key: 'order', type: 'text', title: 'Order', prompt: 'Where the skill goes among the crew\'s skills: lower comes first.', value: () => '100', check: wholeNumber('The order', 10000) },
  ],
  yaml: skillYaml,
};

const MCP_SERVER: KindDefinition = {
  kind: 'MCPServer',
  section: 'mcp',
  questions: [
    nameQuestion('MCPServer'),
    {
      key: 'from',
      type: 'pick',
      title: 'Where the server runs',
      items: () => [
        { label: 'Container image', description: 'the operator runs it in the crew\'s namespace', value: 'image' },
        { label: 'External endpoint', description: 'a server that already runs elsewhere', value: 'endpoint' },
      ],
    },
    { key: 'where', type: 'text', title: 'Image or endpoint', prompt: 'The container image (registry/name:tag), or the endpoint URL of an external server.', check: plainText('an image or a URL') },
  ],
  yaml: mcpServerYaml,
};

const RAG_SOURCE: KindDefinition = {
  kind: 'RAGSource',
  section: 'rag',
  questions: [
    nameQuestion('RAGSource'),
    { key: 'url', type: 'text', title: 'Git repository', prompt: 'The URL of the git repository to index.', check: plainText('a repository URL') },
    { key: 'branch', type: 'text', title: 'Branch', prompt: 'The branch to index.', value: () => 'main', check: tokenList('branch') },
    { key: 'paths', type: 'text', title: 'Paths', prompt: 'The folders or files to index, comma-separated (no globs).', value: () => 'docs/', check: tokenList('path') },
    { key: 'embeddingModel', type: 'text', title: 'Embedding model', prompt: 'The EmbeddingModel that embeds the documents.', value: (c) => names(c, 'EmbeddingModel')[0] ?? 'nomic-embed-text', check: (v) => nameProblem('EmbeddingModel', v) },
    { key: 'endpoint', type: 'text', title: 'Vector store', prompt: 'The pgvector endpoint, host:port/database.', value: (c) => firstField(c, 'RAGSource', (s) => (s.vectorStore as { endpoint?: unknown } | undefined)?.endpoint) ?? '', check: plainText('the vector store endpoint') },
  ],
  yaml: ragSourceYaml,
};

const EMBEDDING_MODEL: KindDefinition = {
  kind: 'EmbeddingModel',
  section: 'rag',
  questions: [
    nameQuestion('EmbeddingModel'),
    { key: 'model', type: 'text', title: 'Model', prompt: 'The embedding model the provider serves, such as nomic-embed-text.', value: () => 'nomic-embed-text', check: plainText('a model name') },
    { key: 'provider', type: 'text', title: 'ModelProvider', prompt: 'The ModelProvider that serves it.', value: (c) => firstField(c, 'Model', (s) => s.providerRef) ?? 'ollama', check: (v) => nameProblem('ModelProvider', v) },
    { key: 'dimensions', type: 'text', title: 'Dimensions', prompt: 'The size of the vectors the model makes.', value: () => '768', check: wholeNumber('The dimensions', 65536) },
  ],
  yaml: embeddingModelYaml,
};

const MODEL: KindDefinition = {
  kind: 'Model',
  section: 'models',
  questions: [
    nameQuestion('Model'),
    { key: 'model', type: 'text', title: 'Model', prompt: 'The model the provider serves, such as qwen3:8b.', check: plainText('a model name') },
    { key: 'provider', type: 'text', title: 'ModelProvider', prompt: 'The ModelProvider it runs on.', value: (c) => firstField(c, 'Model', (s) => s.providerRef) ?? 'ollama', check: (v) => nameProblem('ModelProvider', v) },
    { key: 'capabilities', type: 'text', title: 'Capabilities', prompt: 'The capabilities it offers, comma-separated; the scheduler matches them to the agents\'.', value: () => 'tool-calling', check: tokenList('capability') },
    {
      key: 'latencyClass',
      type: 'pick',
      title: 'Capability tier',
      items: () => [
        { label: 'low', description: 'fast; for speed-leaning capabilities', value: 'low' },
        { label: 'medium', description: 'between the two', value: 'medium' },
        { label: 'high', description: 'slow and thorough; for quality-leaning capabilities', value: 'high' },
      ],
    },
    { key: 'contextWindow', type: 'text', title: 'Context length', prompt: 'The context window in tokens; empty to leave it unset.', value: () => '', check: wholeNumber('The context length', 10_000_000, true) },
  ],
  yaml: modelYaml,
};

const SCHEDULING_POLICY: KindDefinition = {
  kind: 'CrewSchedulingPolicy',
  section: 'policies',
  questions: [nameQuestion('CrewSchedulingPolicy', (c) => `${c.crew}-scheduling`), { key: 'archetype', type: 'text', title: 'Archetype', prompt: 'The MootArchetype whose phases the rules name.', value: () => DEFAULT_ARCHETYPE, check: (v) => nameProblem('MootArchetype', v) }],
  yaml: schedulingPolicyYaml,
  refuse: (c) => {
    const have = ofKind(c, 'CrewSchedulingPolicy').find((p) => specOf(p).crewRef === c.crew);
    return have && `The source already declares CrewSchedulingPolicy ${have.metadata.name} for ${c.crew}; a crew has one. Edit it instead.`;
  },
};

const NOTIFICATION_SINK: KindDefinition = {
  kind: 'NotificationSink',
  section: 'notifications',
  questions: [nameQuestion('NotificationSink'), { key: 'url', type: 'text', title: 'Webhook URL', prompt: 'Where the operator posts when an agent raises a concern, such as an ntfy topic URL.', check: webhookUrl }],
  yaml: notificationSinkYaml,
};

/** An http or https URL. */
export function webhookUrl(v: string): string | undefined {
  const plain = plainText('a webhook URL')(v, { crew: '', objects: [] });
  if (plain) return plain;
  try {
    const url = new URL(v.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : 'The webhook URL starts with http:// or https://.';
  } catch {
    return 'Enter a full URL, such as https://ntfy.example.com/topic.';
  }
}

/** Every kind "Add <Kind>..." creates, by kind. */
export const DEFINITIONS: Record<string, KindDefinition> = Object.fromEntries(
  [AGENT, PROMPT, SKILL, MODEL, RAG_SOURCE, EMBEDDING_MODEL, MCP_SERVER, SCHEDULING_POLICY, NOTIFICATION_SINK].map((d) => [d.kind, d]),
);

/** The file a new object goes in: `templates/<kind>-<name>.yaml` in a chart, `<kind>-<name>.yaml` beside a bundle's Crew. */
export function fileName(kind: string, name: string): string {
  return `${kind.toLowerCase()}-${name}.yaml`;
}
