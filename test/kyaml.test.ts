import { load, loadAll } from 'js-yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { yamlFormat } from '../src/connection';
import type { KubeClient } from '../src/k8s/request';
import { isTypeAmbiguous, needsQuotes, toKyaml } from '../src/source/kyaml';
import { dumpYaml, joinDocuments, toLiveYaml, type Manifest } from '../src/source/manifests';
import { normalizedYaml } from '../src/source/normalize';
import { LiveDocuments } from '../src/views/liveDocuments';
import { ManifestDocuments } from '../src/views/manifestDocuments';
import { FakeCluster, seedCrew } from './fakeCluster';
import { recorded, resetFake, Uri } from './vscodeFake';

beforeEach(() => resetFake());

const agent = {
  apiVersion: 'kubemoot.ai/v1alpha1',
  kind: 'Agent',
  metadata: { name: 'no', labels: { 'app.kubernetes.io/name': 'x', on: 'yes' } },
  spec: { replicas: 3, ratio: 0.5, enabled: true, nothing: null, empty: {}, none: [], tags: ['a', 'no'], rules: [{ a: 1 }, { b: [1, 2] }], mixed: [{ a: 1 }, 's'] },
};

describe('toKyaml', () => {
  it('writes the document as kubectl get -o kyaml does', () => {
    expect(toKyaml(agent)).toBe(`---
{
  apiVersion: "kubemoot.ai/v1alpha1",
  kind: "Agent",
  metadata: {
    name: "no",
    labels: {
      app.kubernetes.io/name: "x",
      "on": "yes",
    },
  },
  spec: {
    replicas: 3,
    ratio: 0.5,
    enabled: true,
    nothing: null,
    empty: {},
    none: [],
    tags: [
      "a",
      "no",
    ],
    rules: [{
      a: 1,
    }, {
      b: [
        1,
        2,
      ],
    }],
    mixed: [
      {
        a: 1,
      },
      "s",
    ],
  },
}
`);
  });

  it('folds multi-line strings, keeping leading whitespace, tabs, and blank lines', () => {
    expect(toKyaml({ prompt: 'line one\n  indented\n\ttabbed\n\nlast\n', trail: 'no newline\nend' })).toBe(
      '---\n{\n  prompt: "\\\n     line one\\n\\\n    \\  indented\\n\\\n    \\\ttabbed\\n\\\n     \\n\\\n     last\\n\\\n    ",\n  trail: "\\\n     no newline\\n\\\n     end\\\n    ",\n}\n',
    );
  });

  it('escapes quotes, backslashes, and characters that do not print', () => {
    expect(toKyaml('say "hi" \\ \x07 \xa0 \u2028 \x01 \x7f \u200b \u00e9 \u{1F600}')).toBe('---\n"say \\"hi\\" \\\\ \\a \\_ \\L \\x01 \\x7f \\u200b \u00e9 \u{1F600}"\n');
  });

  it('names the line and paragraph separators, and writes NaN and the infinities as YAML does', () => {
    expect(toKyaml('a\u2028b\u2029c')).toBe('---\n"a\\Lb\\Pc"\n');
    expect(toKyaml([Number.NaN, Infinity, -Infinity])).toBe('---\n[\n  .nan,\n  .inf,\n  -.inf,\n]\n');
  });

  it('quotes a key only when it must, and keeps line breaks in a key on one line', () => {
    const doc = toKyaml({ '': 1, '-a': 2, 'a b': 3, 'x.y/z-w': 4, '\u00fcn\u00ef': 5, 'a\nb': 6, 't\tab': 7 });
    expect(doc).toContain('  "": 1,\n  "-a": 2,\n  "a b": 3,\n  x.y/z-w: 4,\n  \u00fcn\u00ef: 5,\n  "a\\nb": 6,\n  "t\\tab": 7,\n');
  });

  it('writes bare scalars at the top, drops undefined map values, and writes undefined alone as null', () => {
    expect(toKyaml(42)).toBe('---\n42\n');
    expect(toKyaml(false)).toBe('---\nfalse\n');
    expect(toKyaml(undefined)).toBe('---\nnull\n');
    expect(toKyaml({ a: undefined, b: 'x' })).toBe('---\n{\n  b: "x",\n}\n');
    expect(toKyaml([])).toBe('---\n[]\n');
    expect(toKyaml([[]])).toBe('---\n[[]]\n');
  });

  it('stays YAML: a YAML parser reads back the same object', () => {
    const tricky = { ...agent, data: { text: 'a\n  b\n\tc\n\n', quote: '"\\', unicode: '\u00e9 \u{1F600}', ['0x1F']: 'hex', '2026-10-08': 'date' } };
    expect(load(toKyaml(tricky))).toEqual(tricky);
  });
});

describe('needsQuotes and isTypeAmbiguous', () => {
  it('flags strings a YAML parser would read as null, a boolean, a number, or a timestamp', () => {
    const ambiguous = ['null', 'NULL', '~', 'true', 'False', 'y', 'YES', 'on', 'off', 'n', '1', '0', '-12', '1_000', '0x1F', '0o17', '0b101', '017', '1.5', '.5', '1e9', 'inf', '-Infinity', 'nan', '.inf', '-.inf', '.NaN', '11:00', '2026-10-08', '2026-1-2T03:04:05Z', '2026-01-02 03:04:05.5'];
    for (const s of ambiguous) expect(isTypeAmbiguous(s), s).toBe(true);
    const plain = ['name', 'yesno', 'onboarding', 'v1', '1a', '0x1G', '11:61', '2026-10', 'abc-2026-10-08', 'nullable', ''];
    for (const s of plain) expect(isTypeAmbiguous(s), s).toBe(false);
  });

  it('allows bare keys of letters, digits, and underscores, with - . / only inside', () => {
    for (const s of ['name', 'app.kubernetes.io/name', '_x', 'a-b', '\u00fcn\u00ef']) expect(needsQuotes(s), s).toBe(false);
    for (const s of ['', '-a', 'a-', '.a', 'a/', 'a b', 'a:b', 'on', '1', 'a"b']) expect(needsQuotes(s), s).toBe(true);
  });
});

describe('the yamlFormat setting', () => {
  it('chooses KYAML only when the setting says kyaml', () => {
    expect(yamlFormat()).toBe('yaml');
    recorded.settings.set('crewforge.yamlFormat', 'kyaml');
    expect(yamlFormat()).toBe('kyaml');
    recorded.settings.set('crewforge.yamlFormat', 'json');
    expect(yamlFormat()).toBe('yaml');
  });

  it('writes block YAML by default and KYAML when asked, in every helper', () => {
    const m = agent as unknown as Manifest;
    expect(dumpYaml(m)).toContain('kind: Agent\n');
    expect(dumpYaml(m, 'kyaml')).toBe(toKyaml(m));
    expect(normalizedYaml(m, 'kyaml')).toMatch(/^---\n\{\n {2}apiVersion: "kubemoot\.ai\/v1alpha1",\n/);
    expect(toLiveYaml(m, 'kyaml')).toContain('  kind: "Agent",\n');
    expect(joinDocuments(['a: 1\n', 'b: 2\n'])).toBe('a: 1\n---\nb: 2\n');
    expect(joinDocuments([toKyaml({ a: 1 }), toKyaml({ b: 2 })], 'kyaml')).toBe('---\n{\n  a: 1,\n}\n---\n{\n  b: 2,\n}\n');
  });

  it('turns Show Live YAML, raw and normalized, and a crew bundle into KYAML', async () => {
    const cluster = seedCrew(new FakeCluster());
    const documents = new LiveDocuments(() => ({ source: '/k/config', context: 'lab', client: cluster as unknown as KubeClient }), () => 'kyaml');
    const ref = { kind: 'Crew', name: 'lab-ops', namespace: 'team-a' };
    for (const target of [{ kind: 'object' as const, ref }, { kind: 'object' as const, ref, raw: true }, { kind: 'bundle' as const, namespace: 'team-a', crew: 'lab-ops' }]) {
      await documents.show(target);
      const uri = recorded.shownDocuments.at(-1)?.split(' ')[0] ?? '';
      const shown = await documents.provideTextDocumentContent(Uri.parse(uri) as never);
      expect(shown, uri).toContain('---\n{\n  apiVersion: "kubemoot.ai/v1alpha1",\n');
      expect((loadAll(shown) as Manifest[]).every((m) => m.metadata.name !== undefined), uri).toBe(true);
    }
  });

  it('turns Compare with Live and Show Source YAML into KYAML', async () => {
    const docs = new ManifestDocuments(() => 'kyaml');
    const object = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent', metadata: { name: 'a' }, spec: { promptRefs: ['rules'] } };
    const drift = { kind: 'Agent', name: 'a', state: 'changed' as const, paths: [], live: object, rendered: object };
    await docs.showDrift({ namespace: 'ns', drift });
    const [left, right] = recorded.executed[0].args as [Uri, Uri];
    for (const side of [left, right]) expect(docs.provideTextDocumentContent(side as never)).toContain('  spec: {\n    promptRefs: [\n      "rules",\n    ],\n  },\n');
    await docs.showSource({ namespace: 'ns', drift });
    expect(docs.provideTextDocumentContent(Uri.parse('crewforge-manifest:/rendered/ns/Agent-a.yaml') as never)).toContain('  kind: "Agent",\n');
  });
});
