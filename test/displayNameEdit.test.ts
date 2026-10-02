import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { displayNameScalar, setChartDisplayName, setCrewDisplayName } from '../src/source/displayNameEdit';

const crew = (metadata: string, before = '') =>
  `${before}apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n${metadata}spec:\n  description: "x"\n`;

const annotationsOf = (text: string) => (load(text) as { metadata: { annotations?: Record<string, string> } }).metadata.annotations;

describe('displayNameScalar', () => {
  it('quotes so YAML reads back exactly the text', () => {
    for (const value of ['Homelab Health Guide', 'Lab-Ops "Crew" #2', 'a: b', '# hash', "it's", 'back\\slash', 'true', '日本語']) {
      expect((load(`k: ${displayNameScalar(value, false)}`) as { k: string }).k).toBe(value);
    }
  });

  it('writes text holding "{{" as a Helm action only in a file Helm renders', () => {
    expect(displayNameScalar('a {{ b }}', true)).toBe('{{ "a {{ b }}" | quote }}');
    expect(displayNameScalar('a {{ b }}', false)).toBe('"a {{ b }}"');
    expect(displayNameScalar('a } {', true)).toBe('"a } {"');
  });
});

describe('setCrewDisplayName', () => {
  it('replaces the annotation the Crew has, keeping the rest of the file', () => {
    const text = crew('  name: demo\n  annotations:\n    kubemoot.ai/manage-namespace: "true"\n    kubemoot.ai/display-name: "demo"  \n');
    const out = setCrewDisplayName(text, 'Demo Crew', false)!;
    expect(out).toBe(crew('  name: demo\n  annotations:\n    kubemoot.ai/manage-namespace: "true"\n    kubemoot.ai/display-name: "Demo Crew"\n'));
  });

  it('adds the annotation under existing annotations, at their indent, and annotations when there are none', () => {
    const under = setCrewDisplayName(crew('    name: demo\n    annotations:\n        a: "b"\n'), 'Demo', false)!;
    expect(under).toContain('    annotations:\n        kubemoot.ai/display-name: "Demo"\n        a: "b"\n');
    const added = setCrewDisplayName(crew('  name: demo\n  labels:\n    x: y\n\n  # trailing comment\n'), 'Demo', false)!;
    expect(annotationsOf(added)).toEqual({ 'kubemoot.ai/display-name': 'Demo' });
    expect(added).toContain('    x: y\n  annotations:\n    kubemoot.ai/display-name: "Demo"\n');
    const empty = setCrewDisplayName(crew('  name: demo\n  annotations: {}\n'), 'Demo', false)!;
    expect(annotationsOf(empty)).toEqual({ 'kubemoot.ai/display-name': 'Demo' });
    const commented = setCrewDisplayName(crew('  name: demo\n  annotations: # keep\n    a: b\n'), 'Demo', false)!;
    expect(annotationsOf(commented)).toEqual({ 'kubemoot.ai/display-name': 'Demo', a: 'b' });
  });

  it('finds the Crew among other documents and leaves them alone', () => {
    const policy = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nmetadata:\n  name: p\n  annotations:\n    x: y\n---\n';
    const out = setCrewDisplayName(crew('  name: demo\n', policy) + '---\nkind: Agent\nmetadata:\n  name: a\n', 'Demo', false)!;
    expect(out.startsWith(policy)).toBe(true);
    expect(out).toContain('kind: Crew\nmetadata:\n  name: demo\n  annotations:\n    kubemoot.ai/display-name: "Demo"\nspec:');
    expect(out.endsWith('kind: Agent\nmetadata:\n  name: a\n')).toBe(true);
  });

  it('keeps CRLF line endings, and makes a "{{" display name safe in a chart template', () => {
    const out = setCrewDisplayName(crew('  name: demo\n').replaceAll('\n', '\r\n'), 'x {{ .Values.y }}', true)!;
    expect(out).toContain('  annotations:\r\n    kubemoot.ai/display-name: {{ "x {{ .Values.y }}" | quote }}\r\n');
    expect(out.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('skips Helm action lines around the metadata, and leaves annotations that hold one to a person', () => {
    const wrapped = crew('  name: demo\n  labels:\n{{- include "x.labels" . | nindent 4 }}\n{{- if .Values.extra }}\n    extra: "yes"\n{{- end }}\n');
    const out = setCrewDisplayName(wrapped, 'Demo', true)!;
    expect(out).toContain('{{- end }}\n  annotations:\n    kubemoot.ai/display-name: "Demo"\nspec:');
    expect(setCrewDisplayName(crew('  name: demo\n  annotations:\n    {{- toYaml .Values.annotations | nindent 4 }}\n'), 'Demo', true)).toBeUndefined();
    expect(setCrewDisplayName(crew('  name: demo\n  annotations:\n{{- with .Values.annotations }}\n    a: b\n{{- end }}\n'), 'Demo', true)).toBeUndefined();
  });

  it('leaves a display name written over several lines to a person', () => {
    expect(setCrewDisplayName(crew('  name: demo\n  annotations:\n    kubemoot.ai/display-name: >-\n      Long\n      Name\n'), 'Demo', false)).toBeUndefined();
    expect(setCrewDisplayName(crew('  name: demo\n  annotations:\n    kubemoot.ai/display-name: "Long\n      Name"\n'), 'Demo', false)).toBeUndefined();
  });

  it('refuses a value that is not a display name, so it never writes a line break or half a character', () => {
    for (const bad of ['two\nlines', 'sep\u2028x', String.fromCharCode(0xd800), ' ']) {
      expect(() => displayNameScalar(bad, false), JSON.stringify(bad)).toThrow('cannot be a display name');
    }
  });

  it('gives up where a person should edit: no Crew, no block metadata, or annotations as a flow mapping', () => {
    expect(setCrewDisplayName('kind: Agent\nmetadata:\n  name: a\n', 'X', false)).toBeUndefined();
    expect(setCrewDisplayName('kind: Crew\nspec: {}\n', 'X', false)).toBeUndefined();
    expect(setCrewDisplayName('kind: Crew\nmetadata: {name: a}\n', 'X', false)).toBeUndefined();
    expect(setCrewDisplayName(crew('  name: demo\n  annotations: {a: b}\n'), 'X', false)).toBeUndefined();
  });
});

describe('setChartDisplayName', () => {
  it('sets, adds under, or adds annotations at the top level of Chart.yaml', () => {
    const chart = 'apiVersion: v2\nname: demo\nannotations:\n  kubemoot.ai/crew-chart: "true"\n  kubemoot.ai/display-name: "demo"\n';
    expect(setChartDisplayName(chart, 'Demo')).toBe(chart.replace('"demo"', '"Demo"'));
    const without = setChartDisplayName('apiVersion: v2\nname: demo\nannotations:\n  a: b\n', 'Demo')!;
    expect((load(without) as { annotations: Record<string, string> }).annotations).toEqual({ 'kubemoot.ai/display-name': 'Demo', a: 'b' });
    const none = setChartDisplayName('apiVersion: v2\nname: demo\n\n', 'Demo {{ x }}')!;
    expect(none).toBe('apiVersion: v2\nname: demo\nannotations:\n  kubemoot.ai/display-name: "Demo {{ x }}"\n\n');
    expect(setChartDisplayName('name: demo\nannotations: {a: b}\n', 'X')).toBeUndefined();
  });
});
