import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { isSize, parameterCount, sizeClassFor, sizeOfLatencyClass } from '../src/crew/sizes';
import type { Manifest } from '../src/source/manifests';
import { fasterProblem, phaseProblem, presetNeeds } from '../src/source/needsQuestions';
import { describeNeeds, needsOf, phasesOf, ruleFor, setPhaseNeeds, withNeeds, type PhaseNeeds } from '../src/source/schedulingNeeds';
import { obj } from './fakeCluster';
import { fixture } from './fakes';

/** The kmctl scaffold's Crew and CrewSchedulingPolicy, as kmctl create writes them. */
const SCAFFOLD = fixture('kmctl/test/templates/crew.yaml');
const POLICY_LINE = SCAFFOLD.split('\n').findIndex((l, i, all) => l.startsWith('apiVersion:') && all[i + 1] === 'kind: CrewSchedulingPolicy');

const needs = (over: Partial<PhaseNeeds> = {}): PhaseNeeds => ({ capabilities: ['tool-calling'], preferFaster: 0, ...over });
const policyIn = (text: string) => (load(text.split(/^---$/m).at(-1) ?? '') as { spec: { rules: Record<string, unknown>[] } }).spec;
const edited = (text: string, phase: string, n: PhaseNeeds, at = POLICY_LINE) => {
  const out = setPhaseNeeds(text, at, phase, n);
  if ('refuse' in out) throw new Error(out.refuse);
  return out;
};

describe('model sizes', () => {
  it('derive the size class from the parameter count, as Kubemoot does, at its boundaries', () => {
    expect(['0.5B', '8B', '11.9B', '12B', '29.9B', '30B', '70b', '751M', '1T'].map(sizeClassFor)).toEqual(['small', 'small', 'small', 'medium', 'medium', 'large', 'large', 'small', 'large']);
    expect(parameterCount('14B')).toBe(14e9);
    expect(parameterCount(' 1.5k ')).toBe(1500);
  });

  it('know no size for a count that is not one', () => {
    expect(['', 'B', '14', '14 B', '-1B', '0B', 'fourteenB', '1.2.3B'].map(sizeClassFor)).toEqual(Array(8).fill(undefined));
  });

  it('read the retired latencyClass as the size it stood for', () => {
    expect(['low', 'medium', 'high', 'other', 3].map(sizeOfLatencyClass)).toEqual(['small', 'medium', 'large', undefined, undefined]);
    expect(isSize('medium')).toBe(true);
    expect(isSize('huge')).toBe(false);
  });
});

describe('the needs a rule states', () => {
  const rule = {
    phase: 'triage',
    require: { matchLabels: { 'capability/tool-calling': 'true', 'capability/off': 'false', 'kubemoot.ai/family': 'qwen3' } },
    prefer: [{ weight: 40, selector: { matchLabels: { 'capability/reasoning': 'true' } } }, { weight: 70, selector: { matchLabels: { 'kubemoot.ai/size': 'small' } } }],
    preferFaster: 50,
  };

  it('read required abilities, the preferred size, and preferFaster', () => {
    expect(needsOf(rule)).toEqual({ capabilities: ['tool-calling'], size: 'small', preferFaster: 50 });
    expect(needsOf(undefined)).toEqual({ capabilities: [], preferFaster: 0 });
    expect(needsOf({ phase: 'x', prefer: [{ weight: 100, selector: { matchLabels: { latencyClass: 'low' } } }] })).toEqual({ capabilities: [], size: 'small', preferFaster: 0 });
    expect(needsOf({ phase: 'x', prefer: [{ weight: 1, selector: { matchLabels: { 'kubemoot.ai/size': 'small', other: 'x' } } }], preferFaster: '9' })).toEqual({ capabilities: [], size: undefined, preferFaster: 0 });
  });

  it('say them in a few words', () => {
    expect(describeNeeds(needsOf(rule))).toBe('requires tool-calling · prefers small · preferFaster 50');
    expect(describeNeeds(needsOf(undefined))).toBe('states no needs');
  });

  it('change only the parts the needs say, and keep the rest of the rule', () => {
    expect(withNeeds(rule, { capabilities: ['reasoning', 'vision'], size: 'large', preferFaster: 0 })).toEqual({
      phase: 'triage',
      require: { matchLabels: { 'capability/off': 'false', 'kubemoot.ai/family': 'qwen3', 'capability/reasoning': 'true', 'capability/vision': 'true' } },
      prefer: [{ weight: 40, selector: { matchLabels: { 'capability/reasoning': 'true' } } }, { weight: 70, selector: { matchLabels: { 'kubemoot.ai/size': 'large' } } }],
    });
  });

  it('drop a require, a prefer list, and preferFaster that are left empty, and replace a retired latencyClass preference', () => {
    const old = { phase: 'triage', require: { matchLabels: { 'capability/tool-calling': 'true' } }, prefer: [{ weight: 100, selector: { matchLabels: { latencyClass: 'low' } } }], preferFaster: 20 };
    expect(withNeeds(old, { capabilities: [], preferFaster: 0 })).toEqual({ phase: 'triage' });
    expect(withNeeds(old, { capabilities: [], size: 'small', preferFaster: 0 })).toEqual({ phase: 'triage', prefer: [{ weight: 100, selector: { matchLabels: { 'kubemoot.ai/size': 'small' } } }] });
    const expressions = { phase: 'm', require: { matchExpressions: [{ key: 'a', operator: 'Exists' }] }, prefer: [{ weight: 5, selector: { matchLabels: { 'kubemoot.ai/size': 'small' } }, expressions: [{ key: 'b', operator: 'Exists' }] }] };
    expect(withNeeds(expressions, needs({ size: 'medium' }))).toEqual({
      phase: 'm',
      require: { matchExpressions: [{ key: 'a', operator: 'Exists' }], matchLabels: { 'capability/tool-calling': 'true' } },
      prefer: [expressions.prefer[0], { weight: 100, selector: { matchLabels: { 'kubemoot.ai/size': 'medium' } } }],
    });
  });
});

describe('the phases a needs edit offers', () => {
  it("are the rules' phases, then mulling and triage for the default archetype", () => {
    expect(phasesOf(obj('CrewSchedulingPolicy', 'p', 'n', { rules: [{ phase: 'synthesis' }, { phase: 'triage' }, 'junk'] }))).toEqual(['synthesis', 'triage', 'mulling']);
    expect(phasesOf(obj('CrewSchedulingPolicy', 'p', 'n', { archetypeRef: 'roberts-rules', rules: [{ phase: 'debate' }] }))).toEqual(['debate']);
    expect(phasesOf(obj('CrewSchedulingPolicy', 'p', 'n') as Manifest)).toEqual(['mulling', 'triage']);
    expect(ruleFor(obj('CrewSchedulingPolicy', 'p', 'n', { rules: [{ phase: 'triage', preferFaster: 5 }] }), 'triage')).toEqual({ phase: 'triage', preferFaster: 5 });
  });
});

describe('writing the needs into the policy file', () => {
  it("rewrites the phase's rule in the kmctl scaffold and keeps every comment, the Crew, and the other rule", () => {
    const out = edited(SCAFFOLD, 'triage', needs({ capabilities: ['tool-calling', 'reasoning'], size: 'small', preferFaster: 30 }));
    expect(policyIn(out.text).rules).toEqual([
      { phase: 'mulling', require: { matchLabels: { 'capability/tool-calling': 'true' } } },
      { phase: 'triage', require: { matchLabels: { 'capability/tool-calling': 'true', 'capability/reasoning': 'true' } }, preferFaster: 30, prefer: [{ weight: 100, selector: { matchLabels: { 'kubemoot.ai/size': 'small' } } }] },
    ]);
    const kept = SCAFFOLD.split('\n').filter((l) => l.trimStart().startsWith('#'));
    expect(out.text.split('\n').filter((l) => l.trimStart().startsWith('#'))).toEqual(kept);
    expect(out.text.split('---')[0]).toBe(SCAFFOLD.split('---')[0]);
    expect(out.text.split('\n')[out.line]).toBe('    - phase: triage');
    expect(out.text).toContain('          capability/reasoning: "true"');
  });

  it('adds a rule for a phase the policy does not name, at the end of its rules', () => {
    const out = edited(SCAFFOLD, 'synthesis', needs({ size: 'large' }));
    expect(policyIn(out.text).rules.map((r) => r.phase)).toEqual(['mulling', 'triage', 'synthesis']);
    expect(out.text.split('\n')[out.line]).toBe('    - phase: synthesis');
    expect(out.text.endsWith('kubemoot.ai/size: large\n') || out.text.endsWith('kubemoot.ai/size: large')).toBe(true);
  });

  it('keeps CRLF line endings, list items at the key indent, and a rules list that follows other keys', () => {
    const text = ['apiVersion: kubemoot.ai/v1alpha1', 'kind: CrewSchedulingPolicy', 'metadata:', '  name: p', 'spec:', '  crewRef: lab', '  rules:', '  - phase: mulling', '  # triage next', '  - phase: triage', '    preferFaster: 10', '  qualityBias:', '    default: "0.4"', ''].join('\r\n');
    const out = edited(text, 'mulling', needs(), 0);
    expect(out.text).toContain('\r\n');
    expect(out.text).not.toMatch(/[^\r]\n/);
    const spec = (load(out.text) as { spec: { rules: unknown[]; qualityBias: unknown } }).spec;
    expect(spec.rules).toEqual([{ phase: 'mulling', require: { matchLabels: { 'capability/tool-calling': 'true' } } }, { phase: 'triage', preferFaster: 10 }]);
    expect(spec.qualityBias).toEqual({ default: '0.4' });
    expect(out.text).toContain('  # triage next');
    const added = edited(text, 'synthesis', needs(), 0);
    expect((load(added.text) as { spec: { rules: { phase: string }[] } }).spec.rules.map((r) => r.phase)).toEqual(['mulling', 'triage', 'synthesis']);
  });

  it('adds a rules list to a spec without one, and fills an empty flow list', () => {
    const none = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nmetadata:\n  name: p\nspec:\n  crewRef: lab\n';
    expect((load(edited(none, 'triage', needs(), 0).text) as { spec: unknown }).spec).toEqual({ crewRef: 'lab', rules: [{ phase: 'triage', require: { matchLabels: { 'capability/tool-calling': 'true' } } }] });
    const empty = none + '  rules: [] # none yet\n  archetypeRef: consent-3\n';
    expect((load(edited(empty, 'triage', needs({ capabilities: [] }), 0).text) as { spec: unknown }).spec).toEqual({ crewRef: 'lab', rules: [{ phase: 'triage' }], archetypeRef: 'consent-3' });
  });

  it('finds the policy among other documents, even when told the wrong line', () => {
    const text = `apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: lab\n---\n${SCAFFOLD.split('---\n')[1]}`;
    expect(policyIn(edited(text, 'mulling', needs({ preferFaster: 5 }), 0).text).rules[0]).toEqual({ phase: 'mulling', require: { matchLabels: { 'capability/tool-calling': 'true' } }, preferFaster: 5 });
  });

  it('moves a comment inside the rewritten rule above it, and drops one at the end of a line', () => {
    const text = 'kind: CrewSchedulingPolicy\nspec:\n  rules:\n    # leads the rule\n    - phase: triage\n      # why tool-calling\n      require:\n        matchLabels:\n          capability/tool-calling: "true" # end of line\n    - phase: mulling\n';
    const out = edited(text, 'triage', needs({ preferFaster: 5 }), 0);
    const lines = out.text.split('\n');
    expect(lines.slice(3, 6)).toEqual(['    # leads the rule', '    # why tool-calling', '    - phase: triage']);
    expect(out.line).toBe(5);
    expect(out.text).not.toContain('# end of line');
    expect((load(out.text) as { spec: { rules: unknown[] } }).spec.rules).toEqual([{ phase: 'triage', require: { matchLabels: { 'capability/tool-calling': 'true' } }, preferFaster: 5 }, { phase: 'mulling' }]);
  });

  it('places rules by the indent of a file that nests by four, and nests inside the rewritten rule by two', () => {
    const text = 'kind: CrewSchedulingPolicy\nspec:\n    crewRef: lab\n    rules:\n        - phase: triage\n          preferFaster: 10\n';
    const out = edited(text, 'triage', needs({ size: 'small', preferFaster: 10 }), 0);
    expect(out.text.split('\n').slice(4, 8)).toEqual(['        - phase: triage', '          preferFaster: 10', '          require:', '            matchLabels:']);
    const added = edited('kind: CrewSchedulingPolicy\nspec:\n    crewRef: lab\n', 'mulling', needs({ capabilities: [] }), 0);
    expect(added.text).toBe('kind: CrewSchedulingPolicy\nspec:\n    crewRef: lab\n    rules:\n        - phase: mulling\n');
    expect((load(out.text) as { spec: { rules: unknown[] } }).spec.rules).toEqual([{ phase: 'triage', preferFaster: 10, require: { matchLabels: { 'capability/tool-calling': 'true' } }, prefer: [{ weight: 100, selector: { matchLabels: { 'kubemoot.ai/size': 'small' } } }] }]);
  });

  it('edits a policy that other documents follow, a file without a final newline, and rules led by a comment', () => {
    const policy = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nspec:\n  rules:\n    # first comes triage\n    - phase: triage';
    const out = edited(`${policy}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n`, 'mulling', needs(), 0);
    const [first, second] = out.text.split('---\n');
    expect((load(first) as { spec: { rules: { phase: string }[] } }).spec.rules.map((r) => r.phase)).toEqual(['triage', 'mulling']);
    expect(second).toBe('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n');
    expect(out.text).toContain('    # first comes triage\n    - phase: triage\n');
    const bare = edited(policy, 'triage', needs({ preferFaster: 1 }), 0);
    expect(bare.text.endsWith('preferFaster: 1')).toBe(true);
  });

  it('refuses an indented template that writes into the spec, and edits a policy a Helm condition wraps whole', () => {
    const toYaml = 'kind: CrewSchedulingPolicy\nspec:\n  rules:\n  {{- toYaml .Values.rules | nindent 4 }}\n';
    expect(setPhaseNeeds(toYaml, 0, 'triage', needs())).toEqual({ refuse: 'Helm actions wrap parts of its spec; change it in the chart by hand' });
    const whole = '{{- if .Values.scheduling }}\nkind: CrewSchedulingPolicy\nspec:\n  rules:\n    - phase: triage\n{{- end }}\n';
    const out = edited(whole, 'triage', needs(), 0);
    expect(out.text).toBe('{{- if .Values.scheduling }}\nkind: CrewSchedulingPolicy\nspec:\n  rules:\n    - phase: triage\n      require:\n        matchLabels:\n          capability/tool-calling: "true"\n{{- end }}\n');
  });

  it('reads and replaces a capability label written as an unquoted true', () => {
    const rule = { phase: 'triage', require: { matchLabels: { 'capability/reasoning': true } } };
    expect(needsOf(rule).capabilities).toEqual(['reasoning']);
    expect(withNeeds(rule, needs())).toEqual({ phase: 'triage', require: { matchLabels: { 'capability/tool-calling': 'true' } } });
  });

  it('leaves to a person a file whose rules a template writes, a flow list, a missing policy, or a rule it cannot read', () => {
    const helm = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nmetadata:\n  name: p\nspec:\n  rules:\n    {{- range .Values.rules }}\n    - phase: {{ .phase }}\n    {{- end }}\n';
    expect(setPhaseNeeds(helm, 0, 'triage', needs())).toEqual({ refuse: 'Helm actions wrap parts of its spec; change it in the chart by hand' });
    const inline = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nspec:\n  rules:\n    - phase: {{ .Values.phase }}\n';
    expect(setPhaseNeeds(inline, 0, 'triage', needs())).toEqual({ refuse: 'its rules hold template actions; change them in the chart by hand' });
    // A Helm action around keys of the spec would hide its rules key; adding a second one would break the chart.
    const wrapped = 'kind: CrewSchedulingPolicy\nspec:\n{{- if .Values.x }}\n  crewRef: a\n  rules:\n    - phase: triage\n{{- end }}\n';
    expect(setPhaseNeeds(wrapped, 0, 'triage', needs())).toEqual({ refuse: 'Helm actions wrap parts of its spec; change it in the chart by hand' });
    const crewRef = 'kind: CrewSchedulingPolicy\nspec:\n  crewRef: {{ .Release.Name }}\n  rules:\n    - phase: triage\n';
    expect('text' in setPhaseNeeds(crewRef, 0, 'triage', needs())).toBe(true);
    const flow = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewSchedulingPolicy\nspec:\n  rules: [{phase: triage}]\n';
    expect(setPhaseNeeds(flow, 0, 'triage', needs())).toEqual({ refuse: 'its rules are written as a flow list' });
    expect(setPhaseNeeds('apiVersion: v1\nkind: ConfigMap\n', 0, 'triage', needs())).toEqual({ refuse: 'the file no longer holds a CrewSchedulingPolicy; refresh Crew Sources' });
    expect(setPhaseNeeds('kind: CrewSchedulingPolicy\nspec: {}\n', 0, 'triage', needs())).toEqual({ refuse: 'its spec is not a block mapping' });
    const broken = 'kind: CrewSchedulingPolicy\nspec:\n  rules:\n    - phase: [unclosed\n';
    expect(setPhaseNeeds(broken, 0, 'triage', needs())).toEqual({ refuse: 'the rule on line 4 is not one CrewForge can read' });
  });
});

describe('preset needs', () => {
  it('take the words the questions take', () => {
    expect(presetNeeds({ phase: ' triage ', capabilities: 'tool-calling, reasoning', size: 'small', preferFaster: '50' })).toEqual({ phase: 'triage', needs: { capabilities: ['tool-calling', 'reasoning'], size: 'small', preferFaster: 50 } });
    expect(presetNeeds({ phase: 'mulling', capabilities: [], size: '', preferFaster: '0' })).toEqual({ phase: 'mulling', needs: { capabilities: [], size: undefined, preferFaster: 0 } });
  });

  it('refuse a phase, ability, size, or preferFaster that is not one', () => {
    const base = { phase: 'triage', capabilities: 'tool-calling', size: 'small', preferFaster: '0' };
    expect(presetNeeds({ ...base, phase: 'Triage!' })).toEqual({ problem: phaseProblem('Triage!') });
    expect(presetNeeds({ ...base, capabilities: ['ok', '{{x}}'] })).toEqual({ problem: '"{{x}}" is not an ability.' });
    expect(presetNeeds({ ...base, size: 'huge' })).toEqual({ problem: '"huge" is not a size: small, medium, large, or empty.' });
    expect(presetNeeds({ ...base, preferFaster: '101' })).toEqual({ problem: fasterProblem('101') });
    expect(fasterProblem('-1')).toBeDefined();
    expect(fasterProblem('100')).toBeUndefined();
    expect(phaseProblem('synthesis')).toBeUndefined();
  });
});
