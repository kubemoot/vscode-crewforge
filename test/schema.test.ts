import Ajv from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeTransport } from '../src/k8s/request';
import { buildSchema, rewriteRefs, strict, wantsSchema } from '../src/schema/kubemootSchema';
import { SCHEMA_URI, SchemaProvider, type YamlApi } from '../src/schema/schemaProvider';
import { fixture } from './fakes';
import { recorded, resetFake, Uri } from './vscodeFake';

const openapi = JSON.parse(fixture('kubemoot-openapi.json'));

function validator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(buildSchema(openapi));
}

const agent = {
  apiVersion: 'kubemoot.ai/v1alpha1',
  kind: 'Agent',
  metadata: { name: 'helper', labels: { 'kubemoot.ai/crew': 'demo' } },
  spec: { type: 'chat', description: 'helps', discussRole: 'tooler', promptRefs: ['rules'], temperature: '0.2' },
};

describe('buildSchema', () => {
  it('accepts a valid Kubemoot object and objects of other kinds', () => {
    const validate = validator();
    expect(validate(agent)).toBe(true);
    expect(validate({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' }, data: { anything: 'goes' } })).toBe(true);
  });

  it('rejects a field the CRD does not define, which the API server would drop', () => {
    const validate = validator();
    const mcp = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MCPServer', metadata: { name: 'm' }, spec: { image: 'x', securityContext: { readOnlyRootFilesystem: true } } };
    expect(validate(mcp)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain('securityContext');
    expect(validate({ ...agent, spec: { ...agent.spec, promptRef: ['typo'] } })).toBe(false);
  });

  it('checks value types', () => {
    const validate = validator();
    expect(validate({ ...agent, spec: { ...agent.spec, promptRefs: 'rules' } })).toBe(false);
  });

  it('makes one rule per kind, skipping lists, with references rewritten', () => {
    const schema = buildSchema(openapi) as { allOf: { if: { properties: { kind: { const: string } } } }[]; definitions: Record<string, unknown> };
    expect(schema.allOf.map((r) => r.if.properties.kind.const).sort()).toEqual(['Agent', 'MCPServer']);
    expect(JSON.stringify(schema.definitions)).not.toContain('#/components/schemas/');
    expect(buildSchema({})).toMatchObject({ allOf: [], definitions: {} });
  });

  it('rewrites only component references and closes only listed-property objects', () => {
    expect(rewriteRefs({ a: [{ $ref: '#/components/schemas/X' }, { $ref: 'http://other' }], n: 1 })).toEqual({ a: [{ $ref: '#/definitions/X' }, { $ref: 'http://other' }], n: 1 });
    expect(strict({ properties: { a: {} } })).toEqual({ properties: { a: {} }, additionalProperties: false });
    expect(strict({ properties: {}, 'x-kubernetes-preserve-unknown-fields': true })).not.toHaveProperty('additionalProperties');
    expect(strict({ properties: {}, additionalProperties: { type: 'string' } })).toEqual({ properties: {}, additionalProperties: { type: 'string' } });
    expect(strict([{ type: 'object' }, 3])).toEqual([{ type: 'object' }, 3]);
  });

  it('checks Kubemoot documents but not Helm templates', () => {
    expect(wantsSchema('apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\n')).toBe(true);
    expect(wantsSchema('apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: {{ .Values.name }}\n')).toBe(false);
    expect(wantsSchema('apiVersion: v1\nkind: ConfigMap\n')).toBe(false);
  });
});

describe('SchemaProvider', () => {
  let calls: number;
  let fail: boolean;
  const client: KubeTransport = {
    request: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return JSON.stringify(openapi);
    },
    stream: async () => undefined,
  };

  beforeEach(() => {
    resetFake();
    calls = 0;
    fail = false;
  });

  it('registers with the YAML extension when it is installed, and not otherwise', async () => {
    const provider = new SchemaProvider(() => client);
    expect(await provider.register()).toBe(false);
    const registered: string[] = [];
    const api: YamlApi = { registerContributor: (scheme) => (registered.push(scheme), true) };
    recorded.extensions.set('redhat.vscode-yaml', api);
    expect(await provider.register()).toBe(true);
    expect(registered).toEqual(['crewforge-schema']);
  });

  it('offers the schema for open Kubemoot documents only', () => {
    recorded.textDocuments = [
      { uri: Uri.file('/w/agents.yaml'), getText: () => 'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\n' },
      { uri: Uri.file('/w/cm.yaml'), getText: () => 'apiVersion: v1\nkind: ConfigMap\n' },
    ];
    const provider = new SchemaProvider(() => client);
    expect(provider.requestSchema('file:///w/agents.yaml')).toBe(SCHEMA_URI);
    expect(provider.requestSchema('file:///w/cm.yaml')).toBeUndefined();
    expect(provider.requestSchema('file:///w/closed.yaml')).toBeUndefined();
  });

  it('fetches once per client, and retries after a failure', async () => {
    const provider = new SchemaProvider(() => client);
    expect(JSON.parse(await provider.schemaText()).title).toBe('Kubemoot resources');
    await provider.schemaText();
    expect(calls).toBe(1);
    fail = true;
    const other: KubeTransport = { ...client };
    const offline = new SchemaProvider(() => other);
    expect(await offline.schemaText()).toBe('{}');
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    expect(JSON.parse(await offline.schemaText()).title).toBe('Kubemoot resources');
    expect(await new SchemaProvider(() => undefined).schemaText()).toBe('{}');
  });
});
