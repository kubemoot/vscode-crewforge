import { describe, expect, it } from 'vitest';
import {
  fitnessOf,
  liveOwn,
  mcpInfraOf,
  modelsOf,
  noRelated,
  notificationsOf,
  operatorOf,
  ownerOf,
  policiesOf,
  ragOf,
  relatedOf,
  type Obj,
  type RelationInput,
} from '../src/crew/related';
import { namesOf } from '../src/crew/values';
import { obj } from './fakeCluster';

const NS = 'team-a';
const RELEASE = { 'app.kubernetes.io/instance': 'lab' };
const crew = obj('Crew', 'lab-ops', NS, {}, RELEASE);

function input(objects: Obj[], over: Partial<RelationInput> = {}): RelationInput {
  const pool = new Map<string, Obj[]>();
  for (const o of objects) pool.set(o.kind, [...(pool.get(o.kind) ?? []), o]);
  return { crew: 'lab-ops', namespace: NS, agents: [], skills: [], servers: [], pool, own: liveOwn(crew), missing: () => 'not found', ...over };
}

const summary = (items: { kind: string; name: string; sharedBy?: string; reason: string; object?: unknown }[]) => items.map((r) => `${r.kind}/${r.name}|${r.sharedBy ?? 'own'}|${r.reason}|${r.object ? 'found' : 'missing'}`);

describe('who owns an object', () => {
  it('is the crew for its label or its release, never for an object a controller owns', () => {
    const own = liveOwn(crew);
    expect(own(obj('Model', 'a', NS, {}, { 'kubemoot.ai/crew': 'lab-ops' }))).toBe(true);
    expect(own(obj('Model', 'b', NS, {}, RELEASE))).toBe(true);
    expect(own(obj('Model', 'c', NS, {}, { 'kubemoot.ai/crew': 'other' }))).toBe(false);
    const owned = obj('RAGSource', 'resume', NS, {}, RELEASE);
    owned.metadata.ownerReferences = [{ kind: 'Agent' }];
    expect(own(owned)).toBe(false);
    expect(liveOwn(obj('Crew', 'plain', NS))(obj('Model', 'b', NS, {}, RELEASE))).toBe(false);
  });

  it('names the owner of a shared object: its crew, its release, its namespace, or the cluster', () => {
    expect(ownerOf(obj('Model', 'a', NS, {}, { 'kubemoot.ai/crew': 'other' }))).toBe('crew other');
    expect(ownerOf(obj('Model', 'a', NS, {}, { 'app.kubernetes.io/instance': 'x' }))).toBe('release x');
    expect(ownerOf(obj('ModelProvider', 'p', 'kubemoot'))).toBe('namespace kubemoot');
    expect(ownerOf({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype', metadata: { name: 'consent-3' } })).toBe('the cluster');
  });

  it('reads the names of a reference list and skips anything else', () => {
    expect(namesOf([{ name: 'a' }, { name: '' }, {}, null, { name: 3 }])).toEqual(['a']);
    expect(namesOf('nope')).toEqual([]);
  });
});

describe('Models', () => {
  it('lists every Model in the namespace, own or shared, then the providers they run on, from the namespace before the system namespace', () => {
    const items = modelsOf(
      input([
        obj('Model', 'mine', NS, { providerRef: 'local' }, RELEASE),
        obj('Model', 'theirs', NS, { providerRef: 'ollama' }, { 'kubemoot.ai/crew': 'other' }),
        obj('Model', 'elsewhere', 'team-b', { providerRef: 'x' }),
        obj('Model', 'bare', NS, {}, RELEASE),
        obj('ModelProvider', 'local', NS, {}, RELEASE),
        obj('ModelProvider', 'ollama', 'kubemoot'),
        obj('ModelProvider', 'ollama', 'other-ns'),
      ]),
    );
    expect(summary(items)).toEqual([
      'Model/bare|own|declared for this crew|found',
      'Model/mine|own|declared for this crew|found',
      'Model/theirs|crew other|in the namespace, so the scheduler may bind it|found',
      'ModelProvider/local|own|a Model runs on it|found',
      'ModelProvider/ollama|namespace kubemoot|a Model runs on it|found',
    ]);
  });

  it('keeps a provider no namespace has as missing and shared with the cluster, saying why', () => {
    const items = modelsOf(input([obj('Model', 'm', NS, { providerRef: 'gone' }, RELEASE)], { missing: (k) => `${k} cannot be read` }));
    expect(summary(items).at(-1)).toBe('ModelProvider/gone|the cluster|a Model runs on it; ModelProvider cannot be read|missing');
  });
});

describe('RAG sources', () => {
  it('lists what agents name, then what they were matched to, then what skills name, then the crew own, then their embedding models', () => {
    const agent = obj('Agent', 'k8s', NS, { ragSources: [{ name: 'docs' }] });
    agent.status = { autoDiscoveredRAGSources: [{ name: 'auto' }, { name: 'docs' }] };
    const skill = obj('Skill', 'runbook', NS, { ragSources: [{ name: 'skill-docs' }, { name: 'auto' }] });
    const items = ragOf(
      input(
        [
          obj('RAGSource', 'docs', NS, { embeddingModelRef: 'nomic' }, RELEASE),
          obj('RAGSource', 'auto', NS, { embeddingModelRef: 'nomic' }),
          obj('RAGSource', 'own-only', NS, {}, RELEASE),
          obj('RAGSource', 'stranger', NS, {}),
          obj('EmbeddingModel', 'nomic', NS, {}, RELEASE),
          obj('EmbeddingModel', 'spare', NS, {}, RELEASE),
        ],
        { agents: [agent], skills: [skill] },
      ),
    );
    expect(summary(items)).toEqual([
      'RAGSource/auto|namespace team-a|matched to k8s by its keywords|found',
      'RAGSource/docs|own|named by k8s|found',
      'RAGSource/own-only|own|declared for this crew|found',
      'RAGSource/skill-docs|own|named by skill runbook; not found|missing',
      'EmbeddingModel/nomic|own|a RAG source embeds with it|found',
      'EmbeddingModel/spare|own|declared for this crew|found',
    ]);
  });
});

describe('MCP infrastructure', () => {
  it("lists the namespace's gateways (the first is the agents'), the policies and catalogs they name, and reports on the crew's servers", () => {
    const items = mcpInfraOf(
      input(
        [
          obj('MCPGateway', 'b-gw', NS, { catalogRefs: ['cat'], qualityPolicyRef: 'q' }),
          obj('MCPGateway', 'a-gw', NS, { qualityPolicyRef: 'q' }, RELEASE),
          obj('MCPGateway', 'far', 'team-b', {}),
          obj('MCPCatalog', 'cat', NS, { qualityPolicyRef: 'cat-q' }),
          obj('MCPQualityPolicy', 'q', NS, {}, RELEASE),
          obj('MCPServerReport', 'r-kube', NS, { serverName: 'kubernetes' }),
          obj('MCPServerReport', 'r-other', NS, { serverName: 'other' }),
        ],
        { servers: ['kubernetes'] },
      ),
    );
    expect(summary(items)).toEqual([
      "MCPGateway/a-gw|own|the agents' gateway|found",
      'MCPGateway/b-gw|namespace team-a|another gateway in the namespace|found',
      'MCPQualityPolicy/cat-q|own|a gateway or catalog applies it; not found|missing',
      'MCPQualityPolicy/q|own|a gateway or catalog applies it|found',
      'MCPCatalog/cat|namespace team-a|a gateway reads it|found',
      'MCPServerReport/r-kube|namespace team-a|reports on a server the crew uses|found',
    ]);
  });

  it('is empty without gateways or reports', () => {
    expect(mcpInfraOf(input([]))).toEqual([]);
  });
});

describe('policies, notifications, fitness, and the operator', () => {
  it("lists the crew's scheduling policy as its own and the archetype it runs, the default one when it names none", () => {
    const archetype: Obj = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype', metadata: { name: 'consent-3' } };
    const items = policiesOf(
      input([
        obj('CrewSchedulingPolicy', 'sched', NS, { crewRef: 'lab-ops' }),
        obj('CrewSchedulingPolicy', 'robert', NS, { crewRef: 'lab-ops', archetypeRef: 'roberts-rules' }),
        obj('CrewSchedulingPolicy', 'theirs', NS, { crewRef: 'other' }),
        archetype,
      ]),
    );
    expect(summary(items)).toEqual([
      'CrewSchedulingPolicy/robert|own|its crewRef names this crew|found',
      'CrewSchedulingPolicy/sched|own|its crewRef names this crew|found',
      'MootArchetype/consent-3|the cluster|the scheduling policy runs it|found',
      'MootArchetype/roberts-rules|the cluster|the scheduling policy runs it; not found|missing',
    ]);
    expect(policiesOf(input([]))).toEqual([]);
  });

  it('lists sinks that fire for the crew: no agent filter, a filter naming its agent, or its own', () => {
    const items = notificationsOf(
      input(
        [
          obj('NotificationSink', 'all', NS, { webhook: {} }),
          obj('NotificationSink', 'mine', NS, { agents: ['k8s'] }),
          obj('NotificationSink', 'theirs', NS, { agents: ['elsewhere'] }),
          obj('NotificationSink', 'own-filtered', NS, { agents: ['elsewhere'] }, RELEASE),
          obj('NotificationSink', 'far', 'team-b', {}),
        ],
        { agents: [obj('Agent', 'k8s', NS)] },
      ),
    );
    expect(summary(items)).toEqual([
      'NotificationSink/all|namespace team-a|fires for every agent in the namespace|found',
      'NotificationSink/mine|namespace team-a|fires for agents of this crew|found',
      'NotificationSink/own-filtered|own|declared for this crew; its filter names other agents|found',
    ]);
  });

  it("lists the crew's suites and its own runs, leaving the runs a suite made to the suite", () => {
    const made = obj('CrewFitness', 'suite-run-1', NS, { crewRef: 'lab-ops' });
    made.metadata.ownerReferences = [{ kind: 'CrewFitnessSuite' }];
    const labeled = obj('CrewFitness', 'suite-run-2', NS, { crewRef: 'lab-ops' }, { 'kubemoot.ai/fitness-suite': 'smoke' });
    const items = fitnessOf(input([obj('CrewFitnessSuite', 'smoke', NS, { crewRef: 'lab-ops' }), obj('CrewFitness', 'one-off', NS, { crewRef: 'lab-ops' }), made, labeled, obj('CrewFitness', 'other', NS, { crewRef: 'x' })]));
    expect(summary(items)).toEqual(['CrewFitness/one-off|own|its crewRef names this crew|found', 'CrewFitnessSuite/smoke|own|its crewRef names this crew|found']);
  });

  it("lists the operator's KubemootConfig as shared", () => {
    const items = operatorOf(input([{ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'KubemootConfig', metadata: { name: 'default' } }]));
    expect(summary(items)).toEqual(['KubemootConfig/default|the Kubemoot operator|the defaults every crew runs with|found']);
  });

  it('gathers every group, and has an empty set of groups', () => {
    expect(Object.keys(relatedOf(input([])))).toEqual(Object.keys(noRelated()));
    expect(Object.values(noRelated()).every((g) => g.length === 0)).toBe(true);
  });
});
