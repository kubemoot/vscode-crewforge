import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { strict } from '../src/schema/kubemootSchema';
import { ask, folderFor, removeDetail, SourceDefinitions, styleOf } from '../src/source/defineCommands';
import { DEFINITIONS, fileName, newName, plainText, tokenList, toolsPrompt, webhookUrl, wholeNumber, type DefineContext } from '../src/source/defineKinds';
import type { Located } from '../src/source/locate';
import type { Manifest } from '../src/source/manifests';
import { referrersOf, removalPlan } from '../src/source/removeObject';
import type { SourceEntry } from '../src/source/service';
import { collectionOf, head, labelsHelperIn, promptContent, type Answers, type SourceStyle } from '../src/source/templates';
import type { SourceNode } from '../src/views/sourceTree';
import { obj } from './fakeCluster';
import { fixture } from './fakes';
import { recorded, resetFake, Uri } from './vscodeFake';

const CRD = JSON.parse(fixture('kubemoot-crd-schemas.json')) as { kinds: Record<string, unknown> };
const ajv = new Ajv({ allErrors: true, strict: false });

/** The answers each kind's questions could get, and a helm and a bundle style to write them in. */
const ANSWERS: Record<string, Answers> = {
  Agent: { name: 'k8s-pods', role: 'tooler', capabilities: 'tool-calling, kubernetes', promptRefs: ['rules', 'style'], tools: 'pods_list, events_list' },
  PromptModule: { name: 'rules', form: 'ADL', order: '20' },
  Skill: { name: 'restart', description: 'Restart a crashing pod safely', order: '100' },
  Model: { name: 'qwen-8b', model: 'qwen3:8b', provider: 'ollama', capabilities: 'tool-calling, reasoning', latencyClass: 'low', contextWindow: '40960' },
  RAGSource: { name: 'team-docs', url: 'https://example.com/docs.git', branch: 'main', paths: 'docs/, adr/', embeddingModel: 'nomic', endpoint: 'pg:5432/vectors' },
  EmbeddingModel: { name: 'nomic', model: 'nomic-embed-text', provider: 'ollama', dimensions: '768' },
  MCPServer: { name: 'search', from: 'image', where: 'ghcr.io/example/search:1.0' },
  CrewSchedulingPolicy: { name: 'lab-scheduling', archetype: 'consent-3' },
  NotificationSink: { name: 'pager', url: 'https://ntfy.example.com/lab' },
};
const HELM: SourceStyle = { kind: 'helm', crew: 'lab', labelsHelper: 'lab-crew.labels' };
const BUNDLE: SourceStyle = { kind: 'bundle', crew: 'lab', namespace: 'somewhere' };

/** A template rendered as Helm would with the chart's helper: the namespace filled in, the helper's labels left out. */
const asRendered = (yaml: string): Manifest => load(yaml.replace('{{ .Release.Namespace }}', 'team-a').replace(/^.*\{\{- include .*$\n/m, '')) as Manifest;

describe('the templates of Add <Kind>', () => {
  it.each(Object.keys(DEFINITIONS))('write a %s that the CRD schema accepts, in a chart and in a bundle', (kind) => {
    const validate = ajv.compile(strict(CRD.kinds[kind]) as object);
    for (const style of [HELM, BUNDLE]) {
      const object = asRendered(DEFINITIONS[kind].yaml(style, ANSWERS[kind]));
      expect(validate(object), JSON.stringify(validate.errors)).toBe(true);
      expect(object).toMatchObject({ apiVersion: 'kubemoot.ai/v1alpha1', kind, metadata: { name: ANSWERS[kind].name, labels: { 'kubemoot.ai/crew': 'lab' } } });
    }
  });

  it('follow the source: the chart helper and the release namespace, or the namespace a bundle names, or neither for a kmctl chart', () => {
    expect(head(HELM, 'Skill', 's')).toEqual(['apiVersion: kubemoot.ai/v1alpha1', 'kind: Skill', 'metadata:', '  name: s', '  namespace: {{ .Release.Namespace }}', '  labels:', '    {{- include "lab-crew.labels" . | nindent 4 }}', '    kubemoot.ai/crew: lab']);
    expect(head(BUNDLE, 'Skill', 's')).toContain('  namespace: somewhere');
    expect(head({ kind: 'helm', crew: 'lab' }, 'Skill', 's', { tier: 'low' })).toEqual(['apiVersion: kubemoot.ai/v1alpha1', 'kind: Skill', 'metadata:', '  name: s', '  labels:', '    kubemoot.ai/crew: lab', '    tier: "low"']);
    expect(head({ kind: 'bundle', crew: 'lab' }, 'Skill', 's')).not.toContain('  namespace: somewhere');
  });

  it('give an agent the fields its role and answers call for', () => {
    const coordinator = load(DEFINITIONS.Agent.yaml(BUNDLE, { name: 'boss', role: 'coordinator', capabilities: 'reasoning', promptRefs: [], tools: '' })) as { spec: Record<string, unknown>; metadata: { labels: Record<string, string> } };
    expect(coordinator.spec).toMatchObject({ discussRole: 'coordinator', capabilities: ['reasoning'], promptRefs: [], temperature: '0.1' });
    expect(coordinator.spec.enabledTools).toBeUndefined();
    expect(coordinator.metadata.labels['kubemoot.ai/role']).toBe('coordinator');
    const tooler = load(DEFINITIONS.Agent.yaml(BUNDLE, ANSWERS.Agent)) as { spec: Record<string, unknown> };
    expect(tooler.spec).toMatchObject({ enabledTools: ['pods_list', 'events_list'], promptRefs: ['rules', 'style'], temperature: '0.3' });
  });

  it('write prose or ADL prompts, an external MCP server, and a Model without a context window', () => {
    expect(promptContent('rules', 'prose')).toHaveLength(1);
    expect(promptContent('rules', 'ADL')[0]).toBe('DEFINE DOMAIN rules');
    const prose = load(DEFINITIONS.PromptModule.yaml(BUNDLE, { name: 'p', form: 'prose', order: '5' })) as { spec: { content: string; order: number } };
    expect(prose.spec).toMatchObject({ order: 5, content: expect.stringMatching(/^Describe, in plain sentences/) });
    const external = load(DEFINITIONS.MCPServer.yaml(BUNDLE, { name: 'x', from: 'endpoint', where: 'https://mcp.example.com' })) as { spec: Record<string, unknown> };
    expect(external.spec).toEqual({ externalEndpoint: 'https://mcp.example.com', transport: 'http' });
    const model = load(DEFINITIONS.Model.yaml(BUNDLE, { ...ANSWERS.Model, contextWindow: '' })) as { metadata: { labels: Record<string, string> } };
    expect(model.metadata.labels.contextWindow).toBeUndefined();
    expect(model.metadata.labels['capability/reasoning']).toBe('true');
    expect(collectionOf('team-docs')).toBe('team_docs');
  });

  it('take the first of a list where one answer is wanted, and an empty list for a missing answer', () => {
    expect(DEFINITIONS.Skill.yaml(BUNDLE, { name: ['restart', 'other'], description: 'd', order: '1' })).toContain('  name: restart\n');
    const bare = load(DEFINITIONS.Agent.yaml(BUNDLE, { name: 'a', role: [] })) as { spec: Record<string, unknown> };
    expect(bare.spec).toMatchObject({ discussRole: null, capabilities: [], promptRefs: [] });
  });

  it('find the labels helper a chart defines', () => {
    expect(labelsHelperIn('{{- define "homelab-pilot-crew.labels" -}}\nx\n{{- end }}')).toBe('homelab-pilot-crew.labels');
    expect(labelsHelperIn('{{- define "x.name" -}}')).toBeUndefined();
    expect(fileName('RAGSource', 'docs')).toBe('ragsource-docs.yaml');
  });
});

/** The default a text question of a kind offers. */
function defaultOf(kind: string, key: string, context: DefineContext): string | undefined {
  const q = DEFINITIONS[kind].questions.find((x) => x.key === key);
  return q?.type === 'text' ? q.value?.(context) : undefined;
}

describe('the Add <Kind> commands in the manifest', () => {
  it('has a command, a group menu entry, and an inline entry for every kind CrewForge can add', () => {
    const pkg = JSON.parse(fixture('../../package.json')) as { contributes: { commands: { command: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> } };
    const menu = pkg.contributes.menus['view/item/context'];
    for (const [kind, d] of Object.entries(DEFINITIONS)) {
      const id = `crewforge.add${kind}`;
      expect(pkg.contributes.commands.some((c) => c.command === id), id).toBe(true);
      expect(menu.some((m) => m.command === id && m.when === `view == crewforge.sources && viewItem == declSection-${d.section}` && m.group === 'define@1'), id).toBe(true);
    }
    for (const section of new Set(Object.values(DEFINITIONS).map((d) => d.section))) {
      expect(menu.filter((m) => m.group === 'inline' && m.when === `view == crewforge.sources && viewItem == declSection-${section}`), section).toHaveLength(1);
    }
  });
});

describe('the questions of Add <Kind>', () => {
  const context: DefineContext = { crew: 'lab', objects: [obj('Agent', 'k8s', 'n', { enabledTools: ['b', 'a', 7] }), obj('PromptModule', 'rules', 'n'), obj('Model', 'm', 'n', { providerRef: 'gpu' }), obj('CrewSchedulingPolicy', 'lab-scheduling', 'n', { crewRef: 'lab' })] };

  it('check names, lists, numbers, text, and URLs', () => {
    expect(newName('Agent')('k8s', context)).toBe('The source already declares Agent k8s.');
    expect(newName('Agent')('Bad Name', context)).toMatch(/not a valid Kubernetes name/);
    expect(newName('Agent')('new-one', context)).toBeUndefined();
    expect(tokenList('tool')('a, b.c/d', context)).toBeUndefined();
    expect(tokenList('tool')(' ', context)).toBe('Enter at least one tool.');
    expect(tokenList('tool', true)('', context)).toBeUndefined();
    expect(tokenList('tool')('ok, {{x}}', context)).toMatch(/"\{\{x\}\}" is not a valid tool/);
    expect(wholeNumber('The order', 100)('50', context)).toBeUndefined();
    expect(wholeNumber('The order', 100)('500', context)).toBe('The order is a whole number from 0 to 100.');
    expect(wholeNumber('The order', 100, true)('', context)).toBeUndefined();
    expect(plainText('a description')('', context)).toBe('Enter a description.');
    expect(plainText('a description', true)('', context)).toBeUndefined();
    expect(plainText('a description')('{{ .Values.x }}', context)).toMatch(/cannot hold/);
    expect(plainText('a description')('fine', context)).toBeUndefined();
    expect(webhookUrl('https://ntfy.example.com/t')).toBeUndefined();
    expect(webhookUrl('ftp://x')).toBe('The webhook URL starts with http:// or https://.');
    expect(webhookUrl('nope')).toMatch(/^Enter a full URL/);
    expect(webhookUrl('https://x/{{ .Values.topic }}')).toMatch(/cannot hold "\{\{"/);
  });

  it('offer what the source already uses as defaults and examples, and refuse a second scheduling policy', () => {
    expect(toolsPrompt(context)).toBe('The MCP tools the agent may call, comma-separated; empty for none. The other agents enable: a, b.');
    expect(toolsPrompt({ crew: 'lab', objects: [] })).toBe('The MCP tools the agent may call, comma-separated; empty for none.');
    expect(defaultOf('Model', 'provider', context)).toBe('gpu');
    expect(defaultOf('Model', 'provider', { crew: 'lab', objects: [] })).toBe('ollama');
    expect(DEFINITIONS.CrewSchedulingPolicy.refuse?.(context)).toMatch(/already declares CrewSchedulingPolicy lab-scheduling/);
    expect(DEFINITIONS.CrewSchedulingPolicy.refuse?.({ crew: 'other', objects: context.objects })).toBeUndefined();
    expect(defaultOf('CrewSchedulingPolicy', 'name', context)).toBe('lab-scheduling');
    expect(defaultOf('RAGSource', 'embeddingModel', context)).toBe('nomic-embed-text');
  });

  it('give every question a default, a choice list, or a prompt that reads the source', () => {
    for (const definition of Object.values(DEFINITIONS)) {
      for (const q of definition.questions) {
        if (q.type === 'text') {
          expect(typeof (typeof q.prompt === 'string' ? q.prompt : q.prompt(context))).toBe('string');
          expect(typeof (q.value?.(context) ?? '')).toBe('string');
          expect(q.check('', context) === undefined || typeof q.check('', context) === 'string').toBe(true);
        } else {
          expect(Array.isArray(q.items(context))).toBe(true);
        }
      }
    }
    const endpoint = { crew: 'lab', objects: [obj('RAGSource', 'r', 'n', { vectorStore: { endpoint: 'pg:5432/v' } }), obj('EmbeddingModel', 'e', 'n')] };
    expect(defaultOf('RAGSource', 'endpoint', endpoint)).toBe('pg:5432/v');
    expect(defaultOf('RAGSource', 'embeddingModel', endpoint)).toBe('e');
    expect(defaultOf('RAGSource', 'endpoint', context)).toBe('');
  });

  it('asks each question in turn, and stops when one is cancelled', async () => {
    resetFake();
    recorded.inputs.push('new-agent', 'tool-calling', '');
    recorded.quickPicks.push({ label: 'tooler', value: 'tooler' }, [{ label: 'rules' }]);
    expect(await ask(DEFINITIONS.Agent.questions, context)).toEqual({ name: 'new-agent', role: 'tooler', capabilities: 'tool-calling', promptRefs: ['rules'], tools: '' });
    recorded.inputs.push('another');
    recorded.quickPicks.push(undefined);
    expect(await ask(DEFINITIONS.Agent.questions, context)).toBeUndefined();
    recorded.inputs.push('third');
    recorded.quickPicks.push({ value: 'tooler' }, undefined);
    recorded.inputs.push('x');
    expect(await ask(DEFINITIONS.Agent.questions, context)).toBeUndefined();
    recorded.inputs.length = 0;
    recorded.inputs.push('agent-4', 'reasoning', '');
    recorded.quickPicks.length = 0;
    recorded.quickPicks.push({ value: 'analyst' });
    expect(await ask(DEFINITIONS.Agent.questions, { crew: 'lab', objects: [] })).toMatchObject({ promptRefs: [] });
  });
});

describe('Add <Kind> and Remove from Source', () => {
  let root: string;
  let reloads: number;
  let revealed: string[];
  let located: Located[];

  const entryAt = (dir: string, kind: 'helm' | 'bundle' = 'helm'): SourceEntry => ({ source: { kind, root: dir, label: path.basename(dir) }, identity: { id: dir }, crewName: 'lab' });
  const definitions = () =>
    new SourceDefinitions({
      service: { located: async () => located },
      readText: (f) => fs.readFile(f, 'utf8'),
      reload: async () => {
        reloads++;
        return [{ kind: 'source', entry: entryAt(root) }];
      },
      reveal: async (file) => {
        revealed.push(file);
      },
    });
  const section = (entry: SourceEntry): SourceNode => ({ kind: 'declSection', entry, section: 'agents', items: [] });

  beforeEach(async () => {
    resetFake();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewforge-define-'));
    await fs.mkdir(path.join(root, 'templates'));
    await fs.writeFile(path.join(root, 'templates', '_helpers.tpl'), '{{- define "lab-crew.labels" -}}\napp: lab\n{{- end }}\n');
    reloads = 0;
    revealed = [];
    located = [{ manifest: obj('Crew', 'lab', 'default'), line: 0 }, { manifest: obj('PromptModule', 'rules', 'default'), line: 0 }];
  });

  it('writes a new Agent into the chart with its helpers, opens it, shows it in the tree, and lints the source', async () => {
    recorded.inputs.push('k8s-pods', 'tool-calling', 'pods_list');
    recorded.quickPicks.push({ value: 'tooler' }, [{ label: 'rules' }]);
    const file = await definitions().add('Agent', section(entryAt(root)));
    expect(file).toBe(path.join(root, 'templates', 'agent-k8s-pods.yaml'));
    const text = await fs.readFile(file!, 'utf8');
    expect(text).toContain('{{- include "lab-crew.labels" . | nindent 4 }}');
    expect(text).toContain('  promptRefs: [rules]');
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.open', 'crewforge.lintCrew']);
    expect(recorded.executed[1].args[0]).toMatchObject({ kind: 'source', entry: { source: { root } } });
    expect(reloads).toBe(1);
    expect(revealed).toEqual([file]);
  });

  it('takes preset answers instead of asking, checked as typed answers are', async () => {
    const file = await definitions().add('Skill', section(entryAt(root)), { name: 'restart', description: 'Restart a pod', order: '10' });
    expect(file).toBe(path.join(root, 'templates', 'skill-restart.yaml'));
    expect(recorded.inputOffers).toEqual([]);
    expect(await definitions().add('Skill', section(entryAt(root)), { name: 'Bad Name', description: 'x', order: '1' })).toBeUndefined();
    expect(recorded.errors.at(-1)).toMatch(/^CrewForge: New Skill: Skill "Bad Name" is not a valid Kubernetes name/);
    expect(await definitions().add('MCPServer', section(entryAt(root)), { name: 'm', from: 'image', where: 'img:1' })).toBe(path.join(root, 'templates', 'mcpserver-m.yaml'));
  });

  it('refuses a preset choice the question does not offer, so nothing unchecked reaches the YAML', async () => {
    const base = { name: 'k', capabilities: 'tool-calling', promptRefs: ['rules'], tools: '' };
    expect(await definitions().add('Agent', section(entryAt(root)), { ...base, role: 'x\nkind: Secret' })).toBeUndefined();
    expect(recorded.errors.at(-1)).toMatch(/"x\nkind: Secret" is not one of: tooler, researcher, analyst, coordinator/);
    expect(await definitions().add('Agent', section(entryAt(root)), { ...base, role: ['tooler'] })).toBeUndefined();
    expect(recorded.errors.at(-1)).toMatch(/Choose one of the offered answers/);
    expect(await definitions().add('Agent', section(entryAt(root)), { ...base, role: 'tooler', promptRefs: ['nope'] })).toBeUndefined();
    expect(recorded.errors.at(-1)).toMatch(/"nope" is not one of: rules/);
    expect(await definitions().add('Agent', section(entryAt(root)), { ...base, role: 'tooler', capabilities: ['a'] })).toBeUndefined();
    expect(recorded.errors.at(-1)).toMatch(/Enter one line of text/);
    expect(await definitions().add('Agent', section(entryAt(root)), { ...base, role: 'tooler', promptRefs: 'rules' })).toBe(path.join(root, 'templates', 'agent-k.yaml'));
  });

  it("writes into a bundle's folder with the namespace its Crew names, and plain YAML in a chart without helpers", async () => {
    const crewFile = path.join(root, 'crew.yaml');
    await fs.writeFile(crewFile, 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: lab\n  namespace: somewhere\n');
    // A render places the Crew in the namespace it renders for; the file says where the bundle goes.
    located = [{ manifest: obj('Crew', 'lab', 'default'), file: crewFile, line: 0 }];
    recorded.inputs.push('pager', 'https://ntfy.example.com/lab');
    const bundled = await definitions().add('NotificationSink', section(entryAt(root, 'bundle')));
    expect(bundled).toBe(path.join(root, 'notificationsink-pager.yaml'));
    expect(await fs.readFile(bundled!, 'utf8')).toContain('  namespace: somewhere');
    await fs.rm(path.join(root, 'templates', '_helpers.tpl'));
    expect(await styleOf(entryAt(root), 'lab', [], (f) => fs.readFile(f, 'utf8'))).toEqual({ kind: 'helm', crew: 'lab', labelsHelper: undefined });
    const read = (f: string) => fs.readFile(f, 'utf8');
    expect(await styleOf(entryAt(root, 'bundle'), 'lab', [], read)).toEqual({ kind: 'bundle', crew: 'lab', namespace: undefined });
    await fs.writeFile(path.join(root, 'broken.yaml'), 'a: [');
    expect(await styleOf(entryAt(root, 'bundle'), 'lab', [{ manifest: obj('Crew', 'lab', 'default'), file: path.join(root, 'broken.yaml'), line: 0 }], read)).toEqual({ kind: 'bundle', crew: 'lab', namespace: undefined });
    expect(folderFor(entryAt(root, 'bundle'))).toBe(root);
  });

  it('refuses a kind the source cannot take, a file that exists, and does nothing when cancelled or without a crew', async () => {
    located.push({ manifest: obj('CrewSchedulingPolicy', 'lab-scheduling', 'default', { crewRef: 'lab' }), line: 0 });
    expect(await definitions().add('CrewSchedulingPolicy', section(entryAt(root)))).toBeUndefined();
    expect(recorded.errors[0]).toMatch(/already declares CrewSchedulingPolicy lab-scheduling/);
    await fs.writeFile(path.join(root, 'templates', 'skill-restart.yaml'), 'taken');
    recorded.inputs.push('restart', 'Restart a pod', '100');
    expect(await definitions().add('Skill', section(entryAt(root)))).toBeUndefined();
    expect(recorded.errors[1]).toMatch(/cannot add Skill restart: .*skill-restart.yaml already exists/);
    expect(await definitions().add('Skill', section(entryAt(root)))).toBeUndefined();
    expect(await definitions().add('Skill', undefined)).toBeUndefined();
    expect(await definitions().add('Widget', section(entryAt(root)))).toBeUndefined();
    expect(await definitions().add('Skill', section({ ...entryAt(root), crewName: undefined }))).toBeUndefined();
    recorded.inputs.push('elsewhere', 'Somewhere', '1');
    expect(await definitions().add('Skill', section(entryAt(path.join(root, 'missing-folder'))))).toBeUndefined();
    expect(recorded.errors[2]).toMatch(/cannot add Skill elsewhere: .*ENOENT/);
    expect(reloads).toBe(0);
  });

  const declared = (file: string, kind: string, name: string): SourceNode => ({ kind: 'declared', entry: entryAt(root), item: { label: name, tooltip: '', icon: 'x', file, line: 0, object: { kind, name } } });

  it('removes an object after a confirmation: a file of its own to the trash, or its document out of a shared file', async () => {
    const own = path.join(root, 'templates', 'skill-restart.yaml');
    await fs.writeFile(own, 'apiVersion: kubemoot.ai/v1alpha1\nkind: Skill\nmetadata:\n  name: restart\n');
    recorded.warningAnswers.push('Remove');
    await definitions().remove(declared(own, 'Skill', 'restart'));
    expect(recorded.trashed).toEqual([`${own} (trash)`]);
    const shared = path.join(root, 'templates', 'prompts.yaml');
    await fs.writeFile(shared, 'apiVersion: kubemoot.ai/v1alpha1\nkind: PromptModule\nmetadata:\n  name: rules\n---\napiVersion: kubemoot.ai/v1alpha1\nkind: PromptModule\nmetadata:\n  name: style\n');
    located.push({ manifest: obj('Agent', 'k8s', 'default', { promptRefs: ['style'] }), line: 0 });
    recorded.warningAnswers.push('Remove');
    await definitions().remove(declared(shared, 'PromptModule', 'style'));
    expect(await fs.readFile(shared, 'utf8')).toBe('apiVersion: kubemoot.ai/v1alpha1\nkind: PromptModule\nmetadata:\n  name: rules');
    expect(recorded.warnings).toEqual(['Remove Skill restart from the source?', 'Remove PromptModule style from the source?']);
    expect(reloads).toBe(2);
    expect(recorded.executed.filter((e) => e.id === 'crewforge.lintCrew')).toHaveLength(2);
  });

  it('keeps the file when the removal is cancelled, refused, or the file is unsaved', async () => {
    const file = path.join(root, 'templates', 'models.yaml');
    const text = '{{- range .Values.models }}\n---\napiVersion: kubemoot.ai/v1alpha1\nkind: Model\nmetadata:\n  name: {{ .name }}\n{{- end }}\n';
    await fs.writeFile(file, text);
    await definitions().remove(declared(file, 'Model', 'qwen-8b'));
    expect(recorded.errors[0]).toMatch(/a template makes Model qwen-8b/);
    const plain = path.join(root, 'templates', 'skill.yaml');
    await fs.writeFile(plain, 'apiVersion: kubemoot.ai/v1alpha1\nkind: Skill\nmetadata:\n  name: s\n');
    recorded.warningAnswers.push(undefined);
    await definitions().remove(declared(plain, 'Skill', 's'));
    recorded.textDocuments.push({ uri: Uri.file(plain), getText: () => '', isDirty: true });
    await definitions().remove(declared(plain, 'Skill', 's'));
    expect(recorded.errors[1]).toMatch(/save or close .* before removing Skill s/);
    await definitions().remove(undefined);
    await definitions().remove({ kind: 'declared', entry: entryAt(root), item: { label: 'x', tooltip: '', icon: 'x', line: 0 } });
    expect(await fs.readFile(plain, 'utf8')).toContain('name: s');
    expect(recorded.trashed).toEqual([]);
    expect(reloads).toBe(0);
  });
});

describe('the removal plan', () => {
  const doc = (kind: string, name: string) => `apiVersion: kubemoot.ai/v1alpha1\nkind: ${kind}\nmetadata:\n  name: ${name}`;

  it('trashes a file whose other documents say nothing', () => {
    expect(removalPlan(`# The crew's skill\n---\n${doc('Skill', 's')}\n---\n\n`, 'Skill', 's')).toEqual({ trash: true });
    expect(removalPlan(`{{/* a note */}}\n---\n${doc('Skill', 's')}`, 'Skill', 's')).toEqual({ trash: true });
  });

  it('takes the first document with the separator after it, and a later one with the separator before it', () => {
    const text = `${doc('Skill', 'a')}\n---\n${doc('Skill', 'b')}\n---\n${doc('Skill', 'c')}\n`;
    expect(removalPlan(text, 'Skill', 'a')).toEqual({ trash: false, text: `${doc('Skill', 'b')}\n---\n${doc('Skill', 'c')}\n` });
    expect(removalPlan(text, 'Skill', 'b')).toEqual({ trash: false, text: `${doc('Skill', 'a')}\n---\n${doc('Skill', 'c')}\n` });
    expect(removalPlan(text, 'Skill', 'c')).toEqual({ trash: false, text: `${doc('Skill', 'a')}\n---\n${doc('Skill', 'b')}` });
  });

  it('takes a document with its own template block, and refuses one that shares a block with others', () => {
    const wrapped = `{{- if .Values.a }}\n${doc('MCPServer', 'a')}\n{{- end }}\n---\n{{- if .Values.b }}\n${doc('MCPServer', 'b')}\n{{- end }}\n`;
    expect(removalPlan(wrapped, 'MCPServer', 'b')).toEqual({ trash: false, text: `{{- if .Values.a }}\n${doc('MCPServer', 'a')}\n{{- end }}` });
    const shared = `{{- if .Values.on }}\n${doc('Skill', 'a')}\n---\n${doc('Skill', 'b')}\n{{- end }}\n`;
    expect(removalPlan(shared, 'Skill', 'a')).toEqual({ refuse: 'Skill a sits inside a template block it shares with other objects; remove it by hand.' });
    expect(removalPlan(doc('Skill', 'a'), 'Skill', 'zzz')).toEqual({ refuse: 'the file no longer holds Skill zzz; refresh Crew Sources.' });
  });

  it('names what still points at an object', () => {
    const objects = [
      obj('Agent', 'k8s', 'n', { promptRefs: ['rules'], mcpServers: [{ name: 'kube' }], ragSources: [{ name: 'docs' }] }),
      obj('Skill', 'run', 'n', { mcpServers: [{ name: 'kube' }] }),
      obj('RAGSource', 'docs', 'n', { embeddingModelRef: 'nomic' }),
      obj('MCPGateway', 'gw', 'n', { catalogRefs: ['cat'], qualityPolicyRef: 'q' }),
      obj('MCPCatalog', 'cat', 'n', { qualityPolicyRef: 'q' }),
    ];
    expect(referrersOf(objects, 'PromptModule', 'rules')).toEqual(['Agent k8s']);
    expect(referrersOf(objects, 'MCPServer', 'kube')).toEqual(['Agent k8s', 'Skill run']);
    expect(referrersOf(objects, 'RAGSource', 'docs')).toEqual(['Agent k8s']);
    expect(referrersOf(objects, 'EmbeddingModel', 'nomic')).toEqual(['RAGSource docs']);
    expect(referrersOf(objects, 'MCPQualityPolicy', 'q')).toEqual(['MCPGateway gw', 'MCPCatalog cat']);
    expect(referrersOf(objects, 'MCPCatalog', 'cat')).toEqual(['MCPGateway gw']);
    expect(referrersOf(objects, 'Model', 'any')).toEqual([]);
    expect(removeDetail('/f.yaml', true, ['Agent k8s'])).toBe('/f.yaml moves to the trash. Agent k8s still name it; change them too. Nothing in the cluster changes until the crew is deployed again; the operator cleans up after it.');
    expect(removeDetail('/f.yaml', false, [])).toBe('Its document is removed from /f.yaml; the file keeps the others. Nothing in the cluster changes until the crew is deployed again; the operator cleans up after it.');
  });
});
