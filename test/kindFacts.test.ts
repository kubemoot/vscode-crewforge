import { describe, expect, it } from 'vitest';
import { chunkingText, contextLength, factsOf, gatewayPort, hostOf, indexes, modelCapabilities } from '../src/crew/kindFacts';
import type { Obj, Related } from '../src/crew/related';
import { obj } from './fakeCluster';

const NS = 'team-a';
const related = (o: Obj, over: Partial<Related> = {}): Related => ({ kind: o.kind, name: o.metadata.name, namespace: NS, object: o, reason: 'test', ...over });
const withStatus = (o: Obj, status: Record<string, unknown>): Obj => ({ ...o, status });

describe('Model facts', () => {
  it('give the model name, capability tier, and context length, with every capability label on hover', () => {
    const model = withStatus(obj('Model', 'qwen-8b', NS, { model: 'qwen3:8b', providerRef: 'ollama', vramMib: 5120 }, { latencyClass: 'low', contextWindow: '40960', 'capability/tool-calling': 'true', 'capability/reasoning': 'true', 'capability/off': 'false' }), { ready: true, state: 'Available' });
    const facts = factsOf(related(model));
    expect(facts.description).toBe('qwen3:8b · low tier · 40960 context');
    expect(facts.lines).toEqual(['Model: qwen3:8b', 'Provider: ollama', 'Capability tier (latencyClass): low', 'Capabilities: reasoning, tool-calling', 'Context length: 40960', 'VRAM (MiB): 5120', 'State: Available']);
    expect(facts).toMatchObject({ icon: 'chip', ready: true });
  });

  it('take the context length from the spec, then what the provider reported, then the label', () => {
    expect(contextLength(obj('Model', 'm', NS, { contextLength: 8192 }, { contextWindow: '1' }))).toBe('8192');
    expect(contextLength(withStatus(obj('Model', 'm', NS, {}, { contextWindow: '1' }), { modelInfo: { contextLength: 4096 } }))).toBe('4096');
    expect(contextLength(obj('Model', 'm', NS, {}, { contextWindow: '1' }))).toBe('1');
    expect(contextLength(obj('Model', 'm', NS))).toBeUndefined();
    expect(modelCapabilities(obj('Model', 'm', NS))).toEqual([]);
    expect(factsOf(related(obj('Model', 'm', NS))).lines).toEqual(['Capabilities: none labeled']);
  });
});

describe('RAG facts', () => {
  it('say what a source indexes, its chunking, its embedding model, and when it was last indexed', () => {
    const rag = withStatus(
      obj('RAGSource', 'docs', NS, { source: { type: 'git', git: { url: 'https://x/docs.git', branch: 'main', paths: ['docs/', 'adr/'] } }, embeddingModelRef: 'nomic', vectorStore: { type: 'pgvector', collection: 'docs' }, chunking: { chunkSize: 800, chunkOverlap: 80 } }),
      { conditions: [{ type: 'Ready', status: 'True' }], phase: 'Ready', indexingStats: { lastIndexed: '2026-09-30T08:00:00Z', documentCount: 12 } },
    );
    const facts = factsOf(related(rag));
    expect(facts.description).toBe('git: https://x/docs.git · main · docs/, adr/ · indexed 2026-09-30T08:00:00Z');
    expect(facts.lines).toEqual([
      'Indexes git: https://x/docs.git · main · docs/, adr/',
      'Chunking: 800 characters, 80 overlap',
      'Embedding model: nomic',
      'Vector store: pgvector · docs',
      'Last indexed: 2026-09-30T08:00:00Z',
      'Documents: 12',
      'Phase: Ready',
    ]);
    expect(facts.ready).toBe(true);
  });

  it('name every source type, and the CRD chunking defaults', () => {
    const of = (type: string, field: string, value: Record<string, unknown>) => indexes({ source: { type, [field]: value } });
    expect(of('s3', 's3', { bucket: 'b', prefix: 'p/' })).toBe('s3: b · p/');
    expect(of('url', 'url', { urls: ['https://a', 'https://b'] })).toBe('url: https://a, https://b');
    expect(of('document', 'document', { urls: ['https://d.pdf'] })).toBe('document: https://d.pdf');
    expect(of('nats-kv', 'natsKV', { bucket: 'kv', key: 'k' })).toBe('nats-kv: kv · k');
    expect(of('mcp-registry', 'mcpRegistry', { url: 'https://r' })).toBe('mcp-registry: https://r');
    expect(of('git', 'git', {})).toBe('git');
    expect(indexes({ source: { type: 'ftp' } })).toBe('ftp');
    expect(indexes(undefined)).toBe('unknown source');
    expect(chunkingText(undefined)).toBe('512 characters, 50 overlap');
    const fresh = factsOf(related(withStatus(obj('RAGSource', 'new', NS, {}), { conditions: [{ type: 'Ready', status: 'False' }] })));
    expect(fresh.description).toBe('unknown source · not indexed yet');
    expect(fresh.lines).toContain('Last indexed: not yet');
    expect(fresh.ready).toBe(false);
  });

  it('describe an embedding model', () => {
    const facts = factsOf(related(obj('EmbeddingModel', 'nomic', NS, { model: 'nomic-embed-text', providerRef: 'ollama', dimensions: 768, batchSize: 32 })));
    expect(facts.description).toBe('nomic-embed-text · 768 dimensions');
    expect(facts.lines).toEqual(['Model: nomic-embed-text', 'Provider: ollama', 'Dimensions: 768', 'Batch size: 32']);
    expect(factsOf(related(obj('EmbeddingModel', 'e', NS, { model: 'm' }))).description).toBe('m');
  });
});

describe('MCP and provider facts', () => {
  it('describe a provider, a gateway, a quality policy, a catalog, and a report', () => {
    const provider = factsOf(related(withStatus(obj('ModelProvider', 'ollama', 'kubemoot', { type: 'ollama', endpoint: 'http://o:11434', scheduling: { weight: 100, memoryMiB: 24000 } }), { ready: false, phase: 'Pending' })));
    expect(provider).toMatchObject({ description: 'ollama · http://o:11434', ready: false });
    expect(provider.lines).toEqual(['Type: ollama', 'Endpoint: http://o:11434', 'Weight: 100', 'Memory budget (MiB): 24000', 'Phase: Pending']);

    const gateway = factsOf(related(withStatus(obj('MCPGateway', 'gw', NS, { port: 9090, qualityPolicyRef: 'q', catalogRefs: ['c'] }), { ready: true, mcpServers: ['a', 'b'] })));
    expect(gateway.description).toBe('kubemoot · 2 servers');
    expect(gateway.lines).toContain('Port: 9090');
    expect(gateway.lines).toContain('Catalogs: c');
    expect(gatewayPort(obj('MCPGateway', 'gw', NS))).toBe(8080);

    const policy = factsOf(related(obj('MCPQualityPolicy', 'q', NS, { allowing: [{}, {}], blocking: [{}], considering: { enabled: false, agentRef: 'judge' } })));
    expect(policy.description).toBe('2 allowed · 1 blocked · AI review off');
    expect(policy.lines[0]).toMatch(/^Governs which discovered MCP servers/);
    expect(factsOf(related(obj('MCPQualityPolicy', 'q', NS))).description).toBe('0 allowed · 0 blocked · AI review on');

    expect(factsOf(related(obj('MCPCatalog', 'c', NS, { type: 'official-registry', url: 'https://r', queries: ['k8s'], syncInterval: '24h' }))).lines).toEqual([
      'Discovers MCP servers for a gateway to consider.',
      'Type: official-registry',
      'URL: https://r',
      'Queries: k8s',
      'Sync interval: 24h',
    ]);
    expect(factsOf(related(withStatus(obj('MCPServerReport', 'r', NS, { serverName: 'kube' }), { verdict: 'use' }))).description).toBe('use · kube');
    expect(factsOf(related(obj('MCPServerReport', 'r', NS))).description).toBe('untested');
  });
});

describe('policy, notification, fitness, and operator facts', () => {
  it('say what a scheduling policy governs, and mark one that failed validation', () => {
    const csp = factsOf(related(obj('CrewSchedulingPolicy', 'p', NS, { crewRef: 'c', rules: [{ phase: 'mulling' }, { phase: 'triage' }], qualityBias: { reasoning: '0.7', odd: { x: 1 } } })));
    expect(csp.description).toBe('rules for mulling, triage');
    expect(csp.lines).toContain('Archetype: consent-3');
    expect(csp.lines).toContain('Quality bias: reasoning 0.7, odd ');
    expect(csp.ready).toBeUndefined();
    const bad = factsOf(related(withStatus(obj('CrewSchedulingPolicy', 'p', NS, {}), { validationError: 'phase vote is not in consent-3' })));
    expect(bad).toMatchObject({ description: 'rules for no phases · invalid', ready: false });
  });

  it('give an archetype its phases in order', () => {
    const facts = factsOf(related({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype', metadata: { name: 'consent-3' }, spec: { phases: [{ name: 'triage' }, { name: 'synthesis' }], description: 'Sociocracy' } } as Obj));
    expect(facts.description).toBe('triage, synthesis');
    expect(facts.lines).toContain('Sociocracy');
  });

  it("say where a sink sends concerns by host only, since the rest of its URL may be a secret", () => {
    const sink = factsOf(related(withStatus(obj('NotificationSink', 'pager', NS, { webhook: { url: 'https://ntfy.example.com/secret-topic' }, agents: ['k8s'], channels: ['general'], priority: 'high' }), { ready: true, lastFiredAt: '2026-09-30T09:00:00Z' })));
    expect(sink.description).toBe('ntfy.example.com · 1 agent');
    expect(sink.lines.join('\n')).not.toContain('secret-topic');
    expect(sink.lines).toContain('Last fired: 2026-09-30T09:00:00Z');
    expect(factsOf(related(obj('NotificationSink', 'n', NS, {}))).description).toBe('every agent');
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf(42)).toBeUndefined();
  });

  it('describe fitness suites and runs, and the operator config', () => {
    expect(factsOf(related(withStatus(obj('CrewFitnessSuite', 's', NS, { scripts: [{}, {}], iterations: 3, description: 'Smoke' }), { phase: 'Running' }))).description).toBe('2 scenarios, 3 each · Running');
    expect(factsOf(related(obj('CrewFitnessSuite', 's', NS, {}))).description).toBe('0 scenarios, 1 each');
    expect(factsOf(related(obj('CrewFitness', 'f', NS, { testRef: 'hello' }))).description).toBe('hello');
    expect(factsOf(related({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'KubemootConfig', metadata: { name: 'default' }, status: { ready: true } } as Obj)).lines).toEqual(['The images and defaults the operator gives every crew.', 'Ready: true']);
  });

  it('say why a missing object is missing, and fall back for a kind they do not know', () => {
    expect(factsOf({ kind: 'RAGSource', name: 'gone', reason: 'named by k8s; not found' })).toEqual({ description: 'RAGSource · not found', lines: ['named by k8s; not found'], icon: 'warning' });
    expect(factsOf(related(obj('Widget', 'w', NS)))).toEqual({ description: 'Widget', lines: [], icon: 'symbol-misc' });
  });
});
