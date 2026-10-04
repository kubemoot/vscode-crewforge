import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { toDocuments } from '../src/deploy/deployer';
import { dumpYaml, objectKey, parseManifests, type Manifest } from '../src/source/manifests';

const configMap = (name: string, data: Record<string, string>): Manifest => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data });

// Strings a YAML loader would read as something else when written plain.
const tricky: Record<string, string> = {
  yesWord: 'yes',
  onWord: 'on',
  nullWord: 'null',
  tilde: '~',
  bool: 'true',
  version: '1.10',
  octal: '010',
  date: '2026-01-01',
  empty: '',
  blank: '   ',
  leadingSpace: ' x',
  alias: '*x',
  anchor: '&x',
  colon: 'a: b',
  comment: 'a #b',
  apostrophe: "it's",
  multiline: 'line1\nline2\n',
  docStart: '---',
};

describe('parseManifests', () => {
  it('reads every object of a multi-document stream, skipping empty, comment-only, and ended documents', () => {
    const text = '# header\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n...\n---\n# only a comment\n---\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n';
    expect(parseManifests(text).map(objectKey)).toEqual(['ConfigMap/a', 'ConfigMap/b']);
  });

  it('reads nothing from an empty or blank stream', () => {
    expect(parseManifests('')).toEqual([]);
    expect(parseManifests('  \n# nothing\n')).toEqual([]);
  });

  it('resolves anchors, aliases, and merge keys', () => {
    const text = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: c',
      '  labels: &labels',
      '    app: demo',
      '    tier: crew',
      '  annotations: *labels',
      'data:',
      '  base: &base {a: "1", b: "2"}',
      '  merged:',
      '    <<: *base',
      '    b: "3"',
      '',
    ].join('\n');
    const [m] = parseManifests(text);
    expect(m.metadata.annotations).toEqual({ app: 'demo', tier: 'crew' });
    expect(m.data).toEqual({ base: { a: '1', b: '2' }, merged: { a: '1', b: '3' } });
  });

  it('keeps a date-like scalar a string, as the API server does', () => {
    const [m] = parseManifests('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  since: 2026-01-01\n');
    expect(m.data).toEqual({ since: '2026-01-01' });
  });

  it('reads quoted and plain scalars by their YAML 1.2 types', () => {
    const [m] = parseManifests("apiVersion: v1\nkind: X\nmetadata:\n  name: c\nspec:\n  a: 'yes'\n  b: yes\n  c: \"1.10\"\n  d: 1.10\n  e: 'true'\n  f: true\n  g: ~\n");
    expect(m.spec).toEqual({ a: 'yes', b: 'yes', c: '1.10', d: 1.1, e: 'true', f: true, g: null });
  });

  it('refuses a mapping with a complex key', () => {
    expect(() => parseManifests('apiVersion: v1\nkind: X\nmetadata:\n  name: c\n? [a, b]\n: c\n')).toThrow();
  });
});

describe('YAML round trips', () => {
  it('writes strings that would read as another type so they read back unchanged', () => {
    const m = configMap('tricky', tricky);
    expect(loadAll(dumpYaml(m))).toEqual([m]);
    expect(parseManifests(toDocuments([m]))).toEqual([m]);
  });

  it('quotes the strings a YAML 1.1 reader would take for a boolean, null, or number', () => {
    const text = dumpYaml(tricky);
    for (const key of ['yesWord', 'onWord', 'nullWord', 'tilde', 'bool', 'version', 'octal', 'date']) {
      expect(text).toMatch(new RegExp(`^${key}: ['"]`, 'm'));
    }
  });

  it('writes a multi-document stream that reads back as the same objects in order', () => {
    const objects = [configMap('a', { k: 'v' }), configMap('b', tricky), { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Crew', metadata: { name: 'demo', labels: { app: 'demo' } }, spec: { agents: [{ name: 'x' }, { name: 'y' }] } }];
    const text = toDocuments(objects);
    expect(text.split(/^---$/m)).toHaveLength(3);
    expect(parseManifests(text)).toEqual(objects);
  });

  it('writes a shared value in full each time, never as an anchor and alias', () => {
    const labels = { app: 'demo' };
    const m: Manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', labels, annotations: labels } };
    for (const text of [dumpYaml(m), toDocuments([m])]) {
      expect(text).not.toMatch(/[&*]\w/);
      expect(parseManifests(text)).toEqual([m]);
    }
  });

  it('keeps a long line whole for kubectl and folds it past 120 columns for the editor', () => {
    const long = 'word '.repeat(40).trim();
    const m = configMap('long', { long });
    expect(toDocuments([m])).toContain(`long: ${long}\n`);
    expect(dumpYaml(m)).not.toContain(long);
    expect(parseManifests(dumpYaml(m))).toEqual([m]);
  });

  it('refuses a value YAML cannot hold', () => {
    expect(() => dumpYaml({ f: () => 1 })).toThrow();
  });
});
