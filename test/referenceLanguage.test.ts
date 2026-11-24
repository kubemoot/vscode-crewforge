import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReferenceIndex, candidates, dangling, declarationSpan, namesOf, targetOf } from '../src/language/referenceIndex';
import { CHECK_DEBOUNCE_MS, ReferenceLanguage, registerReferenceLanguage } from '../src/language/register';
import { refSites } from '../src/language/references';
import { readText, readYamlFiles } from '../src/source/nodeDeps';
import type { Exec } from '../src/source/render';
import { SourceService, type SourceEntry } from '../src/source/service';
import { EventEmitter, FakeDiagnostics, recorded, resetFake, Uri } from './vscodeFake';

/** A crew scaffolded by `kmctl create test --chart --members 2 --no-input`, and its recorded render. */
const SCAFFOLD = path.join(__dirname, 'fixtures', 'kmctl', 'test');
const AGENTS = path.join(SCAFFOLD, 'templates', 'agents.yaml');
const MODULES = path.join(SCAFFOLD, 'templates', 'promptmodules.yaml');
const RENDERED = fs.readFileSync(path.join(__dirname, 'fixtures', 'kmctl', 'rendered.yaml'), 'utf8');
const cannedHelm: Exec = async (cmd) => (cmd === 'helm' ? { code: 0, stdout: RENDERED, stderr: '' } : { code: 128, stdout: '', stderr: 'not a repo' });

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

interface FakeDocument {
  uri: Uri;
  languageId: string;
  getText(): string;
}

function document(file: string, text = fs.readFileSync(file, 'utf8')): FakeDocument {
  return { uri: Uri.file(file), languageId: 'yaml', getText: () => text };
}

let entries: SourceEntry[];
let service: SourceService;
let language: ReferenceLanguage;
let index: ReferenceIndex;
let diagnostics: FakeDiagnostics;

beforeEach(async () => {
  resetFake();
  const files = walk(SCAFFOLD);
  service = new SourceService({
    exec: cannedHelm,
    readText,
    readYamlFiles,
    listFiles: async () => ({ charts: files.filter((f) => f.endsWith('Chart.yaml')), yamls: files.filter((f) => /\.ya?ml$/.test(f) && !f.endsWith('Chart.yaml')) }),
  });
  entries = await service.load();
  index = new ReferenceIndex({ entries: () => entries, declarations: (entry) => service.declarations(entry) });
  diagnostics = new FakeDiagnostics('crewforge-references');
  language = new ReferenceLanguage({ index, readText }, diagnostics as never);
});

const at = (line: number, character: number) => ({ line, character }) as vscode.Position;
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle));

describe('the names of a kmctl scaffold', () => {
  it('are its PromptModules and its Crew, with where each is declared', async () => {
    const names = await index.namesFor(AGENTS);
    expect([...(names?.prompts.keys() ?? [])].sort()).toEqual(['advisory-prompt', 'coordinator-decision-logic', 'discussion-protocol', 'response-style', 'synthesis-prompt', 'test-events-system', 'test-workloads-system']);
    expect(names?.prompts.get('response-style')?.file).toBe(MODULES);
    expect(names?.crew).toMatchObject({ name: 'test', file: path.join(SCAFFOLD, 'templates', 'crew.yaml') });
    expect(names?.files).toEqual(expect.arrayContaining([AGENTS, MODULES]));
  });

  it('are read once per source until the index is invalidated, and a file outside any source has none', async () => {
    let reads = 0;
    const counting = new ReferenceIndex({ entries: () => entries, declarations: (e) => (reads++, service.declarations(e)) });
    await counting.namesFor(AGENTS);
    await counting.namesFor(MODULES);
    expect(reads).toBe(1);
    counting.invalidate();
    await counting.namesFor(AGENTS);
    expect(reads).toBe(2);
    expect(await counting.namesFor('/elsewhere/a.yaml')).toBeUndefined();
  });

  it('are none when the source does not render, so no reference is called dangling for it', async () => {
    const broken = new ReferenceIndex({ entries: () => entries, declarations: () => Promise.reject(new Error('render failed')) });
    expect(await broken.namesFor(AGENTS)).toBeUndefined();
  });
});

describe('Go to Definition', () => {
  it('goes from a promptRefs name to the `name:` of its PromptModule', async () => {
    const doc = document(AGENTS);
    const line = lineOf(doc.getText(), 'promptRefs: [discussion-protocol');
    const where = (await language.provideDefinition(doc as never, at(line, doc.getText().split('\n')[line].indexOf('response-style') + 3)))!;
    const modules = fs.readFileSync(MODULES, 'utf8');
    const target = modules.split('\n').indexOf('  name: response-style');
    expect(where.uri.fsPath).toBe(MODULES);
    expect((where.range as unknown as { startLine: number }).startLine).toBe(target);
    expect(where.range).toMatchObject({ startCharacter: 8, endCharacter: 8 + 'response-style'.length });
  });

  it('goes from a crewRef to the Crew', async () => {
    const file = path.join(SCAFFOLD, 'templates', 'crew.yaml');
    const doc = document(file);
    const line = lineOf(doc.getText(), 'crewRef:');
    const where = (await language.provideDefinition(doc as never, at(line, doc.getText().split('\n')[line].indexOf('test'))))!;
    expect(where.uri.fsPath).toBe(file);
    expect(doc.getText().split('\n')[(where.range as unknown as { startLine: number }).startLine]).toBe('  name: test');
  });

  it('finds nothing off a reference, for a name nothing declares, or outside a crew source', async () => {
    const doc = document(AGENTS);
    expect(await language.provideDefinition(doc as never, at(0, 0))).toBeUndefined();
    const dangling = document(AGENTS, 'promptRefs: [nothing-like-it]');
    expect(await language.provideDefinition(dangling as never, at(0, 15))).toBeUndefined();
    const outside = document('/elsewhere/a.yaml', 'promptRefs: [response-style]');
    expect(await language.provideDefinition(outside as never, at(0, 15))).toBeUndefined();
  });
});

describe('Find All References', () => {
  it('lists every agent that composes a module, and its declaration when asked', async () => {
    const doc = document(AGENTS);
    const line = lineOf(doc.getText(), 'promptRefs: [discussion-protocol');
    const column = doc.getText().split('\n')[line].indexOf('discussion-protocol') + 2;
    const without = await language.provideReferences(doc as never, at(line, column), { includeDeclaration: false });
    expect(without.map((l) => path.basename(l.uri.fsPath))).toEqual(['agents.yaml', 'agents.yaml']);
    const withDeclaration = await language.provideReferences(doc as never, at(line, column), { includeDeclaration: true });
    expect(withDeclaration.map((l) => path.basename(l.uri.fsPath)).sort()).toEqual(['agents.yaml', 'agents.yaml', 'promptmodules.yaml']);
  });

  it('works from the declaration of a PromptModule and of the Crew', async () => {
    const modules = document(MODULES);
    const line = lineOf(modules.getText(), '  name: response-style');
    const fromDeclaration = await language.provideReferences(modules as never, at(line, 10), { includeDeclaration: false });
    expect(fromDeclaration).toHaveLength(2);
    const crew = document(path.join(SCAFFOLD, 'templates', 'crew.yaml'));
    const crewLine = lineOf(crew.getText(), '  name: test');
    const crewRefs = await language.provideReferences(crew as never, at(crewLine, 9), { includeDeclaration: true });
    expect(crewRefs.map((l) => path.basename(l.uri.fsPath)).sort()).toEqual(expect.arrayContaining(['crew.yaml']));
    expect(crewRefs.length).toBeGreaterThanOrEqual(2);
  });

  it('prefers the text of an open document to the file as saved', async () => {
    const edited = document(AGENTS, 'spec:\n  promptRefs: [response-style, response-style]\n');
    recorded.textDocuments.push(edited as never);
    const found = await language.provideReferences(edited as never, at(1, 18), { includeDeclaration: false });
    expect(found).toHaveLength(2);
  });

  it('finds nothing off a name', async () => {
    expect(await language.provideReferences(document(AGENTS) as never, at(0, 0), { includeDeclaration: true })).toEqual([]);
  });
});

describe('name completion', () => {
  it('offers the PromptModules of the source in promptRefs, in the span typed so far', async () => {
    const doc = document(AGENTS, 'spec:\n  promptRefs: [discussion-protocol, res');
    const items = await language.provideCompletionItems(doc as never, at(1, 42));
    expect(items.map((i) => i.label)).toEqual(['advisory-prompt', 'coordinator-decision-logic', 'discussion-protocol', 'response-style', 'synthesis-prompt', 'test-events-system', 'test-workloads-system']);
    expect(items[3].range).toMatchObject({ startLine: 1, startCharacter: 39, endCharacter: 42 });
  });

  it('offers the Crew after crewRef, and nothing elsewhere', async () => {
    const crew = await language.provideCompletionItems(document(AGENTS, '  crewRef: ') as never, at(0, 11));
    expect(crew.map((i) => i.label)).toEqual(['test']);
    expect(await language.provideCompletionItems(document(AGENTS, '  description: ') as never, at(0, 15))).toEqual([]);
    expect(await language.provideCompletionItems(document('/elsewhere/a.yaml', '  crewRef: ') as never, at(0, 11))).toEqual([]);
  });
});

describe('dangling references', () => {
  it('warn at the misspelled name and clear when it is fixed', async () => {
    const doc = document(AGENTS, 'spec:\n  promptRefs: [response-stylez, discussion-protocol]\n  crewRef: other\n');
    await language.check(doc as never);
    const found = diagnostics.entries.get(doc.uri.toString())!;
    expect(found.map((d) => [d.severity, d.source, d.range.startLine, d.range.startCharacter, d.message])).toEqual([
      [1, 'CrewForge (references)', 1, 15, expect.stringContaining('PromptModule "response-stylez" is not declared in this crew source')],
      [1, 'CrewForge (references)', 2, 11, 'This crew source declares the Crew "test", not "other".'],
    ]);
    await language.check(document(AGENTS, 'spec:\n  promptRefs: [response-style]\n  crewRef: test\n') as never);
    expect(diagnostics.entries.has(doc.uri.toString())).toBe(false);
  });

  it('are not set for a document that closed while its names were read, and a pending check is dropped on close', async () => {
    const doc = { ...document(AGENTS, 'promptRefs: [nope]'), isClosed: true };
    await language.check(doc as never);
    expect(diagnostics.entries.size).toBe(0);
    language.checkLater(document(AGENTS, 'promptRefs: [nope]') as never);
    language.closed(document(AGENTS) as never);
    await new Promise((r) => setTimeout(r, CHECK_DEBOUNCE_MS + 150));
    expect(diagnostics.entries.size).toBe(0);
  });

  it('say nothing about a scaffold as written, or for a file outside a crew source', async () => {
    for (const file of walk(SCAFFOLD).filter((f) => f.endsWith('.yaml'))) await language.check(document(file) as never);
    expect([...diagnostics.entries.values()].flat()).toEqual([]);
    await language.check(document('/elsewhere/a.yaml', 'promptRefs: [nope]') as never);
    expect(diagnostics.entries.size).toBe(0);
  });

  it('are checked once edits settle, and again for every open document when the sources load', async () => {
    const doc = document(AGENTS, 'promptRefs: [nope]');
    language.checkLater(doc as never);
    language.checkLater(doc as never);
    await new Promise((r) => setTimeout(r, CHECK_DEBOUNCE_MS + 150));
    expect(diagnostics.entries.get(doc.uri.toString())).toHaveLength(1);
    diagnostics.delete(doc.uri);
    recorded.textDocuments.push(doc as never, { ...document('/x/readme.md', 'promptRefs: [nope]'), languageId: 'markdown' } as never);
    language.checkAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(diagnostics.entries.get(doc.uri.toString())).toHaveLength(1);
    expect(diagnostics.entries.has(Uri.file('/x/readme.md').toString())).toBe(false);
    language.dispose();
  });
});

describe('the pieces of the index', () => {
  it('a Crew and PromptModules a source names but does not declare are not in its names', async () => {
    const declared = await service.declarations(entries[0]);
    const names = namesOf('/r', { ...declared, crew: undefined, sections: declared.sections.map((s) => (s.section === 'prompts' ? { ...s, items: [...s.items, { label: 'elsewhere', tooltip: '', icon: 'warning', warn: true, line: 0 }] } : s)) });
    expect(names.prompts.has('elsewhere')).toBe(false);
    expect(names.crew).toBeUndefined();
    expect(candidates(names, 'crewRef')).toEqual([]);
    expect(dangling(names, refSites('crewRef: anything')).length).toBe(0);
    expect(targetOf(names, 'crewRef', 'anything')).toBeUndefined();
  });

  it('a declaration that is not found in its file is reported at the line the object starts at', () => {
    expect(declarationSpan('kind: Other\n', { file: 'f', line: 0 }, 'promptRefs', 'x')).toEqual({ line: 0, start: 0, end: 0 });
  });
});

describe('registration', () => {
  it('registers the definition, reference and completion providers for YAML and Helm templates, and checks documents as they open and change', async () => {
    const loaded = new EventEmitter<void>();
    const context = { subscriptions: [] as { dispose(): void }[] };
    const registered = registerReferenceLanguage(context as never, { index, readText }, loaded.event);
    expect(recorded.languageProviders.map((p) => p.kind)).toEqual(['definition', 'references', 'completion']);
    for (const p of recorded.languageProviders) expect(p.selector).toEqual([{ language: 'yaml', scheme: 'file' }, { language: 'helm', scheme: 'file' }]);
    expect(recorded.languageProviders[2].triggers).toEqual([' ', '[', ',', '"']);

    const doc = document(AGENTS, 'promptRefs: [nope]');
    recorded.textDocuments.push(doc as never);
    loaded.fire();
    await new Promise((r) => setTimeout(r, 50));
    const collection = recorded.diagnostics.findLast((d) => d.name === 'crewforge-references')!;
    expect(collection.entries.get(doc.uri.toString())).toHaveLength(1);
    recorded.documentListeners.close[0](doc);
    expect(collection.entries.has(doc.uri.toString())).toBe(false);
    recorded.documentListeners.open[0]({ ...doc, uri: Uri.file('/not/a/source.txt'), languageId: 'plaintext', getText: () => '' });
    recorded.documentListeners.change[0]({ document: { ...doc, languageId: 'json' } });
    registered.dispose();
    expect(context.subscriptions.length).toBeGreaterThan(5);
  });
});
