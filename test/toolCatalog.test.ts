import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '../src/crew/details';
import { catalogPath, parameters, parseCatalog, readToolCatalog, toolDocument, toolOrigin } from '../src/crew/toolCatalog';
import { KubeError } from '../src/k8s/request';
import { FakeCluster, obj } from './fakeCluster';

const NS = 'team-a';
const PATH = `/api/v1/namespaces/${NS}/services/gw:8080/proxy/tools`;
const BODY = JSON.stringify({
  count: 3,
  tools: [
    { name: 'pods_list', description: 'List pods', inputSchema: { type: 'object', properties: { namespace: {}, label: {} }, required: ['namespace'] }, serverName: 'kubernetes' },
    { name: 'bare' },
    { description: 'no name' },
  ],
});

describe('the gateway tool catalog', () => {
  it('is read through the service proxy of the gateway Service, on its port', () => {
    expect(catalogPath(obj('MCPGateway', 'gw', NS))).toBe(PATH);
    expect(catalogPath(obj('MCPGateway', 'gw', NS, { port: 9000 }))).toBe(`/api/v1/namespaces/${NS}/services/gw:9000/proxy/tools`);
    expect(() => catalogPath({ ...obj('MCPGateway', 'gw', NS), metadata: { name: 'gw' } })).toThrow('namespace "" is not a valid Kubernetes name');
  });

  it('parses the tools, skipping one without a name', () => {
    const tools = parseCatalog(BODY);
    expect([...tools.keys()]).toEqual(['pods_list', 'bare']);
    expect(tools.get('bare')).toEqual({ name: 'bare', description: undefined, inputSchema: undefined, serverName: undefined });
    expect(() => parseCatalog('{"count":0}')).toThrow('the reply has no tool list');
  });

  it('reads the kubemoot gateway, and says plainly why it cannot read the others', async () => {
    const cluster = new FakeCluster();
    cluster.bodies.set(PATH, BODY);
    const read = await readToolCatalog(cluster, obj('MCPGateway', 'gw', NS));
    expect(read.gateway).toBe('gw');
    expect(read.tools?.get('pods_list')?.serverName).toBe('kubernetes');
    expect(cluster.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${PATH}`]);
    expect(await readToolCatalog(cluster, undefined)).toEqual({ unreadable: "the crew's namespace has no MCPGateway" });
    expect(await readToolCatalog(cluster, obj('MCPGateway', 'cf', NS, { implementation: 'contextforge' }))).toEqual({ gateway: 'cf', unreadable: "CrewForge reads only the kubemoot gateway's tool list; cf is contextforge" });
    cluster.failures.set(PATH, new KubeError('services "gw" is forbidden', 403));
    expect(await readToolCatalog(cluster, obj('MCPGateway', 'gw', NS))).toEqual({ gateway: 'gw', unreadable: 'services "gw" is forbidden' });
  });
});

describe('a tool', () => {
  const tool: ToolInfo = { name: 'pods_list', agents: ['k8s', 'nodes'], server: 'status-server', description: 'From status' };

  it('lists its parameters, the required ones marked', () => {
    expect(parameters({ properties: { namespace: {}, label: {} }, required: ['namespace'] })).toBe('namespace (required), label');
    expect(parameters({ properties: 'odd', required: 'odd' })).toBe('');
    expect(parameters(undefined)).toBe('');
  });

  it('comes from the catalog first, else from the server that lists it in its status', () => {
    const catalog = { gateway: 'gw', tools: parseCatalog(BODY) };
    expect(toolOrigin(tool, catalog)).toMatchObject({ server: 'kubernetes', description: 'List pods' });
    expect(toolOrigin(tool, { unreadable: 'no' })).toEqual({ server: 'status-server', description: 'From status', schema: undefined });
    expect(toolOrigin({ name: 'bare', agents: [] }, catalog)).toEqual({ server: undefined, description: undefined, schema: undefined });
  });

  it('has a read-only page with where it comes from, what it does, who enables it, and its input schema', () => {
    const page = toolDocument(tool, { gateway: 'gw', tools: parseCatalog(BODY) });
    expect(page).toContain('# Tool pods_list');
    expect(page).toContain('_Read-only. From the tool catalog of gateway `gw`, read through the Kubernetes service proxy._');
    expect(page).toContain('- From: MCPServer `kubernetes` through gateway `gw`');
    expect(page).toContain('- Enabled by: k8s, nodes');
    expect(page).toContain('List pods');
    expect(page).toContain('"required": [\n    "namespace"\n  ]');
    const unread = toolDocument({ name: 'x', agents: ['a'] }, { unreadable: 'forbidden' });
    expect(unread).toContain("The gateway's tool catalog could not be read: forbidden.");
    expect(unread).toContain('- From: no MCP server of this crew lists it');
    expect(unread).toContain('No description is known.');
    expect(unread).toContain('No input schema is known.');
    expect(toolDocument({ name: 'x', agents: [] })).toContain("No tool catalog was read; what is shown comes from the MCP servers' status.");
  });
});
