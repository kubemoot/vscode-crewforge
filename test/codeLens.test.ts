import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { SourceService } from '../src/source/service';
import { CrewCodeLens } from '../src/views/codeLens';
import { kubemootObjects } from '../src/source/positions';
import { SourceTreeProvider } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { resetFake, Uri, type CodeLens } from './vscodeFake';

const CHART = '/w/charts/demo-crew';
const TEXT = [
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: Crew',
  'metadata:',
  '  name: demo',
  'spec:',
  '  description: new',
  '---',
  '# a comment first',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: PromptModule',
  'metadata:',
  '  labels:',
  '    a: b',
  '  name: "demo-rules"',
  'spec:',
  '  content: rules',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: Agent',
  'metadata:',
  '  name: {{ .Values.agent }}',
  '---',
  'apiVersion: v1',
  'kind: ConfigMap',
  'metadata:',
  '  name: c',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: Model',
].join('\n');

describe('kubemootObjects', () => {
  it('finds each Kubemoot object with its line, kind, and literal name', () => {
    expect(kubemootObjects(TEXT)).toEqual([
      { line: 0, kind: 'Crew', name: 'demo' },
      { line: 8, kind: 'PromptModule', name: 'demo-rules' },
      { line: 17, kind: 'Agent', name: undefined },
      { line: 27, kind: 'Model', name: undefined },
    ]);
    expect(kubemootObjects('kind: Crew\n')).toEqual([]);
  });
});

describe('CrewCodeLens', () => {
  let cluster: FakeCluster;

  beforeEach(() => {
    resetFake();
    cluster = new FakeCluster().add(obj('Crew', 'demo', 'team-a', { description: 'old' }), obj('PromptModule', 'demo-rules', 'team-a', { content: 'rules' }));
  });

  function tree(): SourceTreeProvider {
    const rendered = TEXT.split('\n---\n').filter((d) => !d.includes('{{') && !d.includes('kind: Model')).join('\n---\n');
    const service = new SourceService({
      exec: async (cmd) => (cmd === 'git' ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: rendered, stderr: '' }),
      readText: async () => 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\n',
      readYamlFiles: async () => [],
      listFiles: async () => ({ charts: [`${CHART}/Chart.yaml`], yamls: [`${CHART}/templates/crew.yaml`] }),
    });
    return new SourceTreeProvider(service, () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
  }

  const document = (file: string) => ({ uri: Uri.file(file), getText: () => TEXT }) as never;

  it('offers Ask per deployment on the Crew and the drift state on other objects, once the source is loaded', async () => {
    const sources = tree();
    const lens = new CrewCodeLens(sources);
    let changed = 0;
    lens.onDidChangeCodeLenses(() => changed++);
    const [source] = await sources.getChildren();
    expect(lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`))).toEqual([]);
    await sources.getChildren(source);
    expect(changed).toBe(1);
    const lenses = lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`)) as unknown as CodeLens[];
    expect(lenses.map((l) => [l.range.startLine, l.command?.title, l.command?.command])).toEqual([
      [0, 'Ask in team-a', 'crewforge.askCrew'],
      [8, 'team-a: in sync', 'crewforge.showDrift'],
    ]);
    expect(lenses[1].command?.arguments?.[0]).toMatchObject({ kind: 'resource', drift: { kind: 'PromptModule', name: 'demo-rules' } });
  });

  it('drops lenses once the source is no longer deployed or cannot be read', async () => {
    const sources = tree();
    const lens = new CrewCodeLens(sources);
    const [source] = await sources.getChildren();
    await sources.getChildren(source);
    expect(lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`))).toHaveLength(2);
    cluster.objects = [];
    await sources.getChildren(source);
    expect(lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`))).toEqual([]);
    cluster.add(obj('Crew', 'demo', 'team-a', { description: 'old' }));
    await sources.getChildren(source);
    expect(lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`))).not.toEqual([]);
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crews', new Error('offline'));
    await sources.getChildren(source);
    expect(lens.provideCodeLenses(document(`${CHART}/templates/crew.yaml`))).toEqual([]);
  });

  it('ignores files outside every crew source', async () => {
    const sources = tree();
    await sources.getChildren();
    expect(new CrewCodeLens(sources).provideCodeLenses(document('/elsewhere/x.yaml'))).toEqual([]);
  });
});
