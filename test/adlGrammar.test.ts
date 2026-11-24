import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { INITIAL, Registry, parseRawGrammar, type IGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

const repo = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

/** Where each grammar of this extension, and the YAML grammar it injects into, is on disk. */
const GRAMMARS: Record<string, string> = {
  'source.adl': 'syntaxes/adl.tmLanguage.json',
  'kubemoot.adl.injection': 'syntaxes/adl-injection.tmLanguage.json',
  'source.yaml': 'node_modules/tm-grammars/grammars/yaml.json',
};

let yaml: IGrammar;
let adl: IGrammar;

beforeAll(async () => {
  const wasm = fs.readFileSync(path.join(repo, 'node_modules/vscode-oniguruma/release/onig.wasm'));
  await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (sources) => new OnigScanner(sources), createOnigString: (s) => new OnigString(s) }),
    loadGrammar: async (scope) => (GRAMMARS[scope] ? parseRawGrammar(read(GRAMMARS[scope]), GRAMMARS[scope]) : null),
    // What the extension's package.json says: the injection grammar goes into YAML.
    getInjections: (scope) => (scope === 'source.yaml' ? ['kubemoot.adl.injection'] : undefined),
  });
  yaml = (await registry.loadGrammar('source.yaml')) as IGrammar;
  adl = (await registry.loadGrammar('source.adl')) as IGrammar;
});

interface Token {
  text: string;
  scopes: string[];
}

/** The tokens of each line of `text`, with the scopes each one carries. */
function tokenize(grammar: IGrammar, text: string): Token[][] {
  let state = INITIAL;
  return text.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
}

const scopesOf = (line: Token[], text: string): string[] => line.find((t) => t.text === text)?.scopes ?? [];
const hasScope = (line: Token[], text: string, scope: string): boolean => scopesOf(line, text).some((s) => s.startsWith(scope));
const isAdl = (line: Token[]): boolean => line.some((t) => t.scopes.includes('meta.embedded.block.adl'));

const PROMPT = `apiVersion: kubemoot.ai/v1alpha1
kind: PromptModule
metadata:
  name: discussion-protocol
spec:
  description: WHEN this is prose THEN it is not ADL
  order: 10
  content: |
    DEFINE DOMAIN discussion-protocol
    # a comment
    WHEN the question touches your domain AND you have tools THEN call them
    NEVER claim that a change was made
    ASSERT the tools you have are: \${agent.tools}.

    ALWAYS stay in your domain
  labels:
    kubemoot.ai/crew: demo
---
apiVersion: kubemoot.ai/v1alpha1
kind: PromptModule
`;

describe('ADL as a language', () => {
  it('colors the keywords, the scope names, comments and placeholders of an .adl file', () => {
    const lines = tokenize(adl, ['DEFINE COMPONENT scope', 'WHEN x THEN y', 'NEVER do z', '# NEVER a comment', 'ASSERT(synthesis CONTAINS "node")', 'DEFINE CONST MAX_DURATION AS 480 seconds', 'use ${agent.tools}'].join('\n'));
    expect(hasScope(lines[0], 'DEFINE', 'keyword.other.define.adl')).toBe(true);
    expect(hasScope(lines[0], 'COMPONENT', 'storage.type.scope.adl')).toBe(true);
    expect(hasScope(lines[0], 'scope', 'entity.name.section.adl')).toBe(true);
    expect(hasScope(lines[1], 'WHEN', 'keyword.control.adl')).toBe(true);
    expect(hasScope(lines[1], 'THEN', 'keyword.control.adl')).toBe(true);
    expect(hasScope(lines[2], 'NEVER', 'keyword.control.prohibition.adl')).toBe(true);
    expect(lines[3].every((t) => t.scopes.some((s) => s.includes('comment')))).toBe(true);
    expect(hasScope(lines[4], 'ASSERT', 'keyword.other.assert.adl')).toBe(true);
    expect(hasScope(lines[4], 'CONTAINS', 'keyword.operator.word.adl')).toBe(true);
    expect(hasScope(lines[4], 'node', 'string.quoted.double.adl')).toBe(true);
    expect(hasScope(lines[5], 'MAX_DURATION', 'entity.name.constant.adl')).toBe(true);
    expect(hasScope(lines[5], '480 seconds', 'constant.numeric.adl')).toBe(true);
    expect(hasScope(lines[6], '${agent.tools}', 'variable.other.placeholder.adl')).toBe(true);
    // Lower case words are prose, not keywords.
    expect(lines[6].some((t) => t.scopes.some((s) => s.startsWith('keyword')))).toBe(false);
  });

  it('is injected into the content of a PromptModule, and nowhere else in the YAML', () => {
    const lines = tokenize(yaml, PROMPT);
    expect(isAdl(lines[5])).toBe(false);
    expect(hasScope(lines[5], 'WHEN', 'keyword')).toBe(false);
    expect(isAdl(lines[7])).toBe(false);
    const [define, comment, when, never, assertion, blank, always] = [8, 9, 10, 11, 12, 13, 14].map((i) => lines[i]);
    expect(hasScope(define, 'DEFINE', 'keyword.other.define.adl')).toBe(true);
    expect(hasScope(define, 'discussion-protocol', 'entity.name.section.adl')).toBe(true);
    expect(comment.some((t) => t.scopes.some((s) => s.includes('comment.line.number-sign.adl')))).toBe(true);
    expect(hasScope(when, 'WHEN', 'keyword.control.adl')).toBe(true);
    expect(hasScope(never, 'NEVER', 'keyword.control.prohibition.adl')).toBe(true);
    expect(hasScope(assertion, '${agent.tools}', 'variable.other.placeholder.adl')).toBe(true);
    expect(blank.length).toBeGreaterThan(0);
    expect(hasScope(always, 'ALWAYS', 'keyword.control.adl')).toBe(true);
  });

  it('ends with the block scalar, at the next key of the key that holds it', () => {
    const lines = tokenize(yaml, PROMPT);
    // `labels:` is indented like `content:`, so the block is over, and so is the next document.
    expect(lines.slice(15).some(isAdl)).toBe(false);
    expect(lines[15].filter((t) => t.scopes.includes('entity.name.tag.yaml')).map((t) => t.text).join('')).toBe('labels');
  });

  it('is injected into each testContent of a fitness suite, also on a list item line', () => {
    const suite = [
      'spec:',
      '  scripts:',
      '    - testRef: pods',
      '      testContent: |',
      '        DESCRIPTION Workloads: the crew lists pods.',
      '        ASSERT(synthesis CONTAINS "hello")',
      '    - testContent: >-',
      '        WHEN a THEN b',
      '  crewRef: demo',
    ].join('\n');
    const lines = tokenize(yaml, suite);
    expect(hasScope(lines[4], 'DESCRIPTION', 'keyword.other.directive.adl')).toBe(true);
    expect(hasScope(lines[5], 'CONTAINS', 'keyword.operator.word.adl')).toBe(true);
    expect(hasScope(lines[7], 'WHEN', 'keyword.control.adl')).toBe(true);
    expect(isAdl(lines[8])).toBe(false);
  });

  it('leaves other block scalars alone, such as a ConfigMap script', () => {
    const lines = tokenize(yaml, ['data:', '  script: |', '    WHEN x THEN y'].join('\n'));
    expect(isAdl(lines[2])).toBe(false);
  });
});

describe('the extension contributes ADL', () => {
  const pkg = JSON.parse(read('package.json')) as { contributes: { languages: { id: string; extensions: string[]; configuration: string }[]; grammars: { path: string; scopeName: string; injectTo?: string[] }[] } };

  it('registers the .adl language, its grammar, and the injection into YAML and Helm templates', () => {
    expect(pkg.contributes.languages).toMatchObject([{ id: 'adl', extensions: ['.adl'] }]);
    const injection = pkg.contributes.grammars.find((g) => g.scopeName === 'kubemoot.adl.injection');
    expect(injection?.injectTo).toEqual(['source.yaml', 'source.helm']);
    for (const g of pkg.contributes.grammars) expect(fs.existsSync(path.join(repo, g.path)), g.path).toBe(true);
    expect(fs.existsSync(path.join(repo, pkg.contributes.languages[0].configuration))).toBe(true);
  });

  it('has a language configuration with line comments and brackets, in valid JSON', () => {
    const config = JSON.parse(read('adl-language-configuration.json')) as { comments: { lineComment: string }; brackets: string[][] };
    expect(config.comments.lineComment).toBe('#');
    expect(config.brackets).toContainEqual(['(', ')']);
  });
});
