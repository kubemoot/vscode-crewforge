import { describe, expect, it } from 'vitest';
import { completionAt, declSites, refSites, siteAt } from '../src/language/references';

const names = (text: string) => refSites(text).map((s) => `${s.field}:${s.name}@${s.line}:${s.start}-${s.end}`);

describe('refSites', () => {
  it('finds the names of a flow list, with their columns', () => {
    expect(names('  promptRefs: [advisory-prompt, "response-style", \'x\']')).toEqual(['promptRefs:advisory-prompt@0:15-30', 'promptRefs:response-style@0:33-47', 'promptRefs:x@0:51-52']);
  });

  it('finds the items of a block list, whether or not the dashes are indented', () => {
    const text = ['spec:', '  promptRefs:', '    - a # first', '    - "b"', '  other: 1', 'x:', '  promptRefs:', '  - c', 'y: 2'].join('\n');
    expect(names(text)).toEqual(['promptRefs:a@2:6-7', 'promptRefs:b@3:7-8', 'promptRefs:c@7:4-5']);
  });

  it('finds a crewRef, quoted or bare, and not one made with a template action', () => {
    expect(names('  crewRef: "hello"\n  crewRef: bare # note\n  crewRef: {{ .Release.Name }}\n  crewRef: ""')).toEqual(['crewRef:hello@0:12-17', 'crewRef:bare@1:11-15']);
  });

  it('leaves out names made with template actions and anything that is not a name', () => {
    expect(names('promptRefs: [{{ .Values.module }}, ok, "has space", -bad]')).toEqual(['promptRefs:ok@0:35-37']);
    expect(names('promptRefs: [] # none\npromptRefs:\n  - {{ x }}\n')).toEqual([]);
  });

  it('does not read a prompt, or any block scalar, as references', () => {
    const text = ['spec:', '  content: |', '    promptRefs: [fake]', '    crewRef: fake', '  crewRef: real', '  items:', '    - note: >-', '        crewRef: also-fake', '  promptRefs: [real-too]'].join('\n');
    expect(names(text)).toEqual(['crewRef:real@4:11-15', 'promptRefs:real-too@8:15-23']);
  });

  it('reads a Windows text and a text with no references', () => {
    expect(names('promptRefs: [a]\r\ncrewRef: b\r\n')).toEqual(['promptRefs:a@0:13-14', 'crewRef:b@1:9-10']);
    expect(refSites('')).toEqual([]);
    expect(refSites('kind: Agent\nspec:\n  description: x\n')).toEqual([]);
  });
});

describe('declSites', () => {
  const doc = (kind: string, name: string, extra = '') => `apiVersion: kubemoot.ai/v1alpha1\nkind: ${kind}\nmetadata:\n  labels:\n    a: b\n  name: ${name}${extra}\nspec: {}\n`;

  it('finds where each PromptModule and Crew writes its name', () => {
    const text = [doc('PromptModule', 'one'), doc('Crew', '"two"'), doc('Agent', 'three'), doc('PromptModule', 'four # note')].join('---\n');
    expect(declSites(text).map((s) => `${s.kind}:${s.name}@${s.line}:${s.start}-${s.end}`)).toEqual(['PromptModule:one@5:8-11', 'Crew:two@13:9-12', 'PromptModule:four@29:8-12']);
  });

  it('skips a name made with a template action, a missing name and a document without metadata', () => {
    expect(declSites(doc('PromptModule', '{{ .Release.Name }}-x'))).toEqual([]);
    expect(declSites('kind: Crew\nmetadata:\n  labels: {}\n')).toEqual([]);
    expect(declSites('kind: Crew\nspec: {}\n')).toEqual([]);
    expect(declSites('')).toEqual([]);
  });
});

describe('siteAt', () => {
  it('finds the site under or at the end of the cursor, on its line only', () => {
    const sites = refSites('  promptRefs: [aa, bb]\n  crewRef: c');
    expect(siteAt(sites, 0, 16)?.name).toBe('aa');
    expect(siteAt(sites, 0, 17)?.name).toBe('aa');
    expect(siteAt(sites, 0, 14)).toBeUndefined();
    expect(siteAt(sites, 0, 18)).toBeUndefined();
    expect(siteAt(sites, 1, 11)?.name).toBe('c');
    expect(siteAt(sites, 2, 0)).toBeUndefined();
  });
});

describe('completionAt', () => {
  const at = (text: string) => {
    const lines = text.split('\n');
    return completionAt(text, lines.length - 1, lines.at(-1)!.length);
  };

  it('completes a name typed in a flow list, after a comma or a quote', () => {
    expect(at('  promptRefs: [')).toMatchObject({ field: 'promptRefs', start: 15, end: 15 });
    expect(at('  promptRefs: [discussion-protocol, res')).toMatchObject({ field: 'promptRefs', start: 36, end: 39 });
    expect(at('  promptRefs: ["res')).toMatchObject({ field: 'promptRefs', start: 16, end: 19 });
  });

  it('completes a block list item under promptRefs, and not under another key', () => {
    expect(at('spec:\n  promptRefs:\n    - a\n    - re')).toMatchObject({ field: 'promptRefs', line: 3, start: 6, end: 8 });
    expect(at('spec:\n  promptRefs:\n  - ')).toMatchObject({ field: 'promptRefs', start: 4, end: 4 });
    expect(at('spec:\n  capabilities:\n    - re')).toBeUndefined();
    expect(at('- re')).toBeUndefined();
  });

  it('completes a crewRef value', () => {
    expect(at('  crewRef: he')).toMatchObject({ field: 'crewRef', start: 11, end: 13 });
    expect(at('  crewRef: "')).toMatchObject({ field: 'crewRef', start: 12, end: 12 });
  });

  it('completes after a quote or a comma with spaces, and a long line with no comma stays quick', () => {
    expect(at("  promptRefs: [a,   'b")).toMatchObject({ field: 'promptRefs', start: 21, end: 22 });
    expect(at(`  promptRefs: [${'x'.repeat(20_000)}`)).toMatchObject({ field: 'promptRefs', end: 20_015 });
    expect(at('  promptRefs: [a b')).toBeUndefined();
  });

  it('offers nothing elsewhere', () => {
    expect(at('  description: pro')).toBeUndefined();
    expect(at('  promptRefs: [a]')).toBeUndefined();
    expect(completionAt('x', 5, 0)).toBeUndefined();
  });
});
