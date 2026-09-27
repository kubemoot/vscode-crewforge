import { describe, expect, it } from 'vitest';
import { compare, differences, summarize } from '../src/source/drift';
import { obj } from './fakeCluster';

describe('differences', () => {
  it('ignores fields the source leaves out, such as server defaults', () => {
    expect(differences({ a: 1 }, { a: 1, defaulted: true }, 'spec')).toEqual([]);
  });

  it('names each differing path, nested and in arrays', () => {
    const want = { prompt: 'new', tools: ['a', 'b'], deployment: { replicas: 2 } };
    const have = { prompt: 'old', tools: ['a', 'c'], deployment: { replicas: 2 } };
    expect(differences(want, have, 'spec')).toEqual(['spec.prompt', 'spec.tools[1]']);
  });

  it('reports a whole array or object when its shape differs', () => {
    expect(differences({ tools: ['a'] }, { tools: ['a', 'b'] }, 'spec')).toEqual(['spec.tools']);
    expect(differences({ tools: ['a'] }, { tools: 'a' }, 'spec')).toEqual(['spec.tools']);
    expect(differences({ d: { r: 1 } }, { d: ['r'] }, 'spec')).toEqual(['spec.d']);
    expect(differences({ d: { r: 1 } }, undefined, 'spec')).toEqual(['spec']);
  });

  it('treats a number and its text as equal, and null in the source as unset', () => {
    expect(differences({ cpu: 2, temp: '0.2', unset: null }, { cpu: '2', temp: 0.2 }, 'spec')).toEqual([]);
    expect(differences({ cpu: 2 }, { cpu: null }, 'spec')).toEqual(['spec.cpu']);
    expect(differences({ flag: false }, {}, 'spec')).toEqual(['spec.flag']);
  });
});

describe('compare', () => {
  const crew = obj('Crew', 'demo', 'ns', { description: 'd' });
  const rules = obj('PromptModule', 'rules', 'ns', { content: 'new' });

  it('sorts objects into in sync, changed, missing, and extra', () => {
    const live = [obj('Crew', 'demo', 'ns', { description: 'd', extra: 1 }), obj('PromptModule', 'rules', 'ns', { content: 'old' }), obj('Agent', 'gone', 'ns')];
    const drift = compare([crew, rules, obj('Agent', 'fresh', 'ns')], live);
    expect(drift.map((d) => [d.kind, d.name, d.state, d.paths])).toEqual([
      ['Agent', 'fresh', 'missing', []],
      ['Agent', 'gone', 'extra', []],
      ['Crew', 'demo', 'in-sync', []],
      ['PromptModule', 'rules', 'changed', ['spec.content']],
    ]);
  });

  it('leaves non-Kubemoot objects out of the comparison', () => {
    const role = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'r' } };
    expect(compare([crew, role], [crew]).map((d) => d.kind)).toEqual(['Crew']);
  });

  it('summarizes counts, or says in sync', () => {
    expect(summarize(compare([crew], [crew]))).toBe('in sync');
    expect(summarize(compare([crew, rules], [obj('Agent', 'x', 'ns')]))).toBe('2 missing, 1 extra');
  });
});
