import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compiled, lintSource, parseHelmLint, schemaIssues, type LintDeps } from '../src/lint/lint';
import { CrewLinter, SAVE_DEBOUNCE_MS } from '../src/lint/linter';
import { buildSchema } from '../src/schema/kubemootSchema';
import type { CrewSource } from '../src/source/discover';
import type { Exec, ExecResult } from '../src/source/render';
import type { SourceEntry } from '../src/source/service';
import { fixture } from './fakes';
import { FakeDiagnostics, recorded, resetFake } from './vscodeFake';

const ROOT = '/w/demo';
const chart: CrewSource = { kind: 'helm', root: ROOT, label: 'demo' };
const bundle: CrewSource = { kind: 'bundle', root: '/w/bundle', label: 'bundle' };
const SCHEMA = JSON.stringify(buildSchema(JSON.parse(fixture('kubemoot-openapi.json'))));

const AGENTS = [
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: Agent',
  'metadata:',
  '  name: helper',
  'spec:',
  '  type: chat',
  '  promptRef: [typo]',
  '  promptRefs: rules',
].join('\n');
const FILES: Record<string, string> = { [`${ROOT}/templates/agents.yaml`]: AGENTS };

let lintAnswer: ExecResult;
let templateAnswer: ExecResult;
const exec: Exec = async (_cmd, args) => (args[0] === 'lint' ? lintAnswer : templateAnswer);

function deps(schema = SCHEMA, over: Partial<LintDeps> = {}): LintDeps {
  return {
    exec,
    readYamlFiles: async () => [{ file: '/w/bundle/crew.yaml', text: 'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: b\nspec:\n  nope: 1\n' }],
    readText: async (file) => FILES[file] ?? (file === '/w/bundle/crew.yaml' ? 'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: b\nspec:\n  nope: 1\n' : Promise.reject(new Error('gone'))),
    schema: async () => schema,
    ...over,
  };
}

beforeEach(() => {
  resetFake();
  lintAnswer = { code: 0, stdout: '==> Linting\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed', stderr: '' };
  templateAnswer = { code: 0, stdout: `---\n# Source: demo/templates/agents.yaml\n${AGENTS}\n`, stderr: '' };
});

describe('parseHelmLint', () => {
  it('reads each finding with its severity, and the file and line it points at', () => {
    const out = [
      '==> Linting /w/demo',
      '[INFO] Chart.yaml: icon is recommended',
      '[WARNING] templates/crew.yaml: object name does not conform',
      '[ERROR] templates/: parse error at (demo/templates/bad.yaml:5): function "bad" not defined',
      'Error: 1 chart(s) linted, 1 chart(s) failed',
    ].join('\n');
    expect(parseHelmLint(ROOT, out)).toEqual([
      { file: `${ROOT}/Chart.yaml`, line: 0, severity: 'info', message: 'icon is recommended', source: 'helm lint' },
      { file: `${ROOT}/templates/crew.yaml`, line: 0, severity: 'warning', message: 'object name does not conform', source: 'helm lint' },
      { file: `${ROOT}/templates/bad.yaml`, line: 4, severity: 'error', message: 'parse error at (demo/templates/bad.yaml:5): function "bad" not defined', source: 'helm lint' },
    ]);
  });
});

describe('schemaIssues', () => {
  it('says which field is wrong, in plain words, with the keys that lead to it', () => {
    const validate = compiled(SCHEMA)!;
    const agent = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent', metadata: { name: 'helper' }, spec: { type: 'chat', promptRef: ['typo'], promptRefs: 'rules' } };
    expect(validate(agent)).toBe(false);
    const issues = schemaIssues(agent, validate.errors ?? []);
    expect(issues).toContainEqual({ keys: ['spec', 'promptRef'], message: 'Agent/helper: spec has no field "promptRef"; the API server would drop it.' });
    expect(issues).toContainEqual({ keys: ['spec', 'promptRefs'], message: 'Agent/helper: spec.promptRefs must be array.' });
    expect(issues.some((i) => i.message.includes('"then"'))).toBe(false);
    const nested = schemaIssues(agent, [{ keyword: 'type', instancePath: '/spec/mcpServers/1/name', schemaPath: '', params: {} }, { keyword: 'required', instancePath: '', schemaPath: '', params: {}, message: undefined }]);
    expect(nested.map((i) => i.message)).toEqual(['Agent/helper: spec.mcpServers[1].name is not valid.', 'Agent/helper: the object is not valid.']);
  });

  it('puts a dot before every key but the first, and brackets around every index, wherever it sits', () => {
    const agent = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent', metadata: { name: 'helper' } };
    const at = (instancePath: string) => schemaIssues(agent, [{ keyword: 'type', instancePath, schemaPath: '', params: {}, message: 'is wrong' }])[0].message;
    expect(at('/spec')).toBe('Agent/helper: spec is wrong.');
    expect(at('/0')).toBe('Agent/helper: [0] is wrong.');
    expect(at('/0/name')).toBe('Agent/helper: [0].name is wrong.');
    expect(at('/spec/tools/0/1/name')).toBe('Agent/helper: spec.tools[0][1].name is wrong.');
    expect(at('/spec/env/2/valueFrom/key')).toBe('Agent/helper: spec.env[2].valueFrom.key is wrong.');
  });

  it('compiles a schema once per text, and none for an empty schema', () => {
    expect(compiled(SCHEMA)).toBe(compiled(SCHEMA));
    expect(compiled('{}')).toBeUndefined();
  });
});

describe('lintSource', () => {
  it('reports helm lint findings and schema problems on the right file and line', async () => {
    const { findings, notes } = await lintSource(chart, deps());
    expect(notes).toEqual([]);
    expect(findings.map((f) => [f.source, f.severity, f.file, f.line])).toEqual([
      ['helm lint', 'info', `${ROOT}/Chart.yaml`, 0],
      ['schema', 'error', `${ROOT}/templates/agents.yaml`, 6],
      ['schema', 'error', `${ROOT}/templates/agents.yaml`, 7],
    ]);
  });

  it('skips the schema check when the cluster gives no schema, and says so', async () => {
    const { findings, notes } = await lintSource(chart, deps('{}'));
    expect(findings).toHaveLength(1);
    expect(notes[0]).toContain('schema check was skipped');
  });

  it('turns a failed render into a finding where it points, and stops there', async () => {
    templateAnswer = { code: 1, stdout: '', stderr: 'Error: parse error at (demo/templates/agents.yaml:3): bad' };
    const { findings } = await lintSource(chart, deps());
    expect(findings.at(-1)).toMatchObject({ source: 'render', file: `${ROOT}/templates/agents.yaml`, line: 2, severity: 'error' });
    templateAnswer = { code: 1, stdout: '', stderr: 'Error: no place given' };
    expect((await lintSource(chart, deps())).findings.at(-1)).toMatchObject({ file: `${ROOT}/Chart.yaml`, line: 0 });
    const broken = await lintSource(bundle, deps(SCHEMA, { readYamlFiles: async () => Promise.reject(new Error('no folder')) }));
    expect(broken.findings).toEqual([{ file: '/w/bundle', line: 0, severity: 'error', message: 'no folder', source: 'render' }]);
    const thrown = await lintSource(bundle, deps(SCHEMA, { readYamlFiles: async () => Promise.reject('odd') }));
    expect(thrown.findings[0].message).toBe('odd');
  });

  it('reports a failed helm lint that printed no finding, and names helm when it is missing', async () => {
    lintAnswer = { code: 1, stdout: '', stderr: 'Error unable to check Chart.yaml file in chart' };
    const { findings } = await lintSource(chart, deps());
    expect(findings[0]).toMatchObject({ file: `${ROOT}/Chart.yaml`, severity: 'error', message: 'helm lint failed: Error unable to check Chart.yaml file in chart' });
    lintAnswer = { code: 127, stdout: '', stderr: 'helm was not found on PATH' };
    await expect(lintSource(chart, deps())).rejects.toThrow(/needs helm on your PATH.*https:\/\/helm\.sh/);
  });

  it('lints a bundle without helm, and checks objects whose file cannot be read on the first line', async () => {
    const { findings } = await lintSource(bundle, deps());
    expect(findings.map((f) => [f.file, f.line, f.message])).toEqual([['/w/bundle/crew.yaml', 5, 'Agent/b: spec has no field "nope"; the API server would drop it.']]);
    const unreadable = await lintSource(chart, deps(SCHEMA, { readText: async () => Promise.reject(new Error('gone')) }));
    expect(unreadable.findings.filter((f) => f.source === 'schema').map((f) => f.line)).toEqual([0, 0]);
  });
  it('keeps each invalid object\'s findings when a valid object validates while it reads its file', async () => {
    const bad = (name: string) => `apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: ${name}\nspec:\n  nope: 1\n`;
    const good = 'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: ok\nspec: {}\n';
    const files: Record<string, string> = { '/w/bundle/a.yaml': bad('a'), '/w/bundle/b.yaml': bad('b'), '/w/bundle/ok.yaml': good };
    // Each read of a.yaml returns only after the matching read of b.yaml has, so a.yaml is
    // still reading while the other objects validate, whatever the machine's speed.
    const bReads: (() => void)[] = [];
    const bRead = [0, 1].map((i) => new Promise<void>((r) => (bReads[i] = r)));
    let aCount = 0;
    let bCount = 0;
    const slowRead = async (file: string) => {
      if (file.endsWith('a.yaml')) await bRead[aCount++];
      if (file.endsWith('b.yaml')) bReads[bCount++]?.();
      return files[file];
    };
    const { findings } = await lintSource(bundle, deps(SCHEMA, {
      readYamlFiles: async () => Object.entries(files).map(([file, text]) => ({ file, text })),
      readText: slowRead,
    }));
    expect(findings.filter((f) => f.source === 'schema').map((f) => f.file).sort()).toEqual(['/w/bundle/a.yaml', '/w/bundle/b.yaml']);
  });
});

describe('CrewLinter', () => {
  const entry: SourceEntry = { source: chart, identity: { id: 'local:demo' }, crewName: 'demo' };
  let collection: FakeDiagnostics;
  const output = { appendLine: (l: string) => recorded.output.push(l) } as never;
  const linter = (d = deps()) => new CrewLinter(collection as never, d, output);

  beforeEach(() => (collection = new FakeDiagnostics('crewforge')));
  afterEach(() => vi.useRealTimers());

  it('shows findings in the Problems panel by file, replacing the source\'s earlier ones, and says how many', async () => {
    const l = linter();
    await l.lintCommand(entry);
    expect([...collection.entries.keys()].sort()).toEqual([`file://${ROOT}/Chart.yaml`, `file://${ROOT}/templates/agents.yaml`]);
    const [first] = collection.entries.get(`file://${ROOT}/templates/agents.yaml`)!;
    expect(first).toMatchObject({ severity: 0, source: 'CrewForge (schema)', range: { startLine: 6 } });
    expect(recorded.info[0]).toBe('Lint: demo has 2 problems; see the Problems panel.');
    templateAnswer = { code: 0, stdout: '', stderr: '' };
    lintAnswer = { code: 0, stdout: '[WARNING] Chart.yaml: odd', stderr: '' };
    await l.lintCommand(entry);
    expect([...collection.entries.keys()]).toEqual([`file://${ROOT}/Chart.yaml`]);
    expect(recorded.info[1]).toBe('Lint: demo has 1 problem; see the Problems panel.');
    lintAnswer = { code: 0, stdout: '', stderr: '' };
    await linter(deps('{}')).lintCommand(entry);
    expect(recorded.info[2]).toBe('Lint: demo has no problems. The Kubemoot schema check was skipped: CrewForge could not read the schemas from the cluster.');
  });

  it('says once when helm is missing on save, every time on the command, and reports other failures', async () => {
    lintAnswer = { code: 127, stdout: '', stderr: '' };
    const l = linter();
    expect(await l.run(entry, false)).toBeUndefined();
    await l.run(entry, false);
    expect(recorded.warnings).toHaveLength(1);
    await l.lintCommand(entry);
    expect(recorded.warnings).toHaveLength(2);
    const failing = linter(deps(SCHEMA, { schema: async () => Promise.reject(new Error('no cluster')) }));
    lintAnswer = { code: 0, stdout: '', stderr: '' };
    await failing.run(entry, false);
    expect(recorded.errors).toEqual([]);
    await failing.lintCommand(entry);
    expect(recorded.errors).toEqual(['CrewForge: no cluster']);
    expect(recorded.output.filter((l) => l.startsWith('Lint: '))).toHaveLength(5);
  });

  it('lints on save once the saves settle, and stops waiting when disposed', async () => {
    vi.useFakeTimers();
    const l = linter();
    const after = vi.fn();
    l.lintOnSave(entry, after);
    l.lintOnSave(entry, after);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][0].findings).toHaveLength(3);
    l.lintOnSave(entry);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    l.lintOnSave(entry, after);
    l.dispose();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
