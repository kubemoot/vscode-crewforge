import { checkName } from '../k8s/paths';
import type { KubeTransport } from '../k8s/request';
import type { Manifest } from '../source/manifests';
import { errorText } from '../views/errors';
import { gatewayPort } from './kindFacts';
import type { ToolInfo } from './details';
import type { Obj } from './related';
import { text } from './values';

/** One tool as a gateway's catalog lists it. */
export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** The MCPServer the gateway routes the tool to. */
  serverName?: string;
}

/** A gateway's tool catalog, or why it could not be read. */
export interface ToolCatalog {
  gateway?: string;
  tools?: Map<string, CatalogTool>;
  unreadable?: string;
}

/**
 * The Kubemoot gateway's tool list through the API server's service proxy: the Service
 * shares the gateway's name and listens on its spec.port. GET only; nothing is called.
 */
export function catalogPath(gateway: Manifest): string {
  const ns = checkName('namespace', gateway.metadata.namespace ?? '');
  const name = checkName('gateway', gateway.metadata.name);
  return `/api/v1/namespaces/${ns}/services/${name}:${gatewayPort(gateway as Obj)}/proxy/tools`;
}


/** The tools of a `GET /tools` reply: `{count, tools: [{name, description, inputSchema, serverName}]}`. */
export function parseCatalog(body: string): Map<string, CatalogTool> {
  const parsed = JSON.parse(body) as { tools?: unknown };
  if (!Array.isArray(parsed.tools)) throw new Error('the reply has no tool list');
  const tools = new Map<string, CatalogTool>();
  for (const t of parsed.tools as Record<string, unknown>[]) {
    const name = text(t?.name);
    if (!name) continue;
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as Record<string, unknown>) : undefined;
    tools.set(name, { name, description: text(t.description), inputSchema: schema, serverName: text(t.serverName) });
  }
  return tools;
}

/**
 * Reads the tool catalog of the gateway the agents use. Only the Kubemoot gateway serves
 * a tool list CrewForge knows how to read; for another implementation, or no gateway, or
 * a failed read, the catalog says why in plain words.
 */
export async function readToolCatalog(client: KubeTransport, gateway: Manifest | undefined): Promise<ToolCatalog> {
  if (!gateway) return { unreadable: "the crew's namespace has no MCPGateway" };
  const name = gateway.metadata.name;
  const implementation = text((gateway as Obj).spec?.implementation) ?? 'kubemoot';
  if (implementation !== 'kubemoot') return { gateway: name, unreadable: `CrewForge reads only the kubemoot gateway's tool list; ${name} is ${implementation}` };
  try {
    return { gateway: name, tools: parseCatalog(await client.request('GET', catalogPath(gateway))) };
  } catch (err) {
    return { gateway: name, unreadable: errorText(err) };
  }
}

/** The input parameters of a tool's schema, required ones marked: "namespace (required), name". */
export function parameters(schema: Record<string, unknown> | undefined): string {
  const props = schema?.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]) : []);
  return props.map((p) => (required.has(p) ? `${p} (required)` : p)).join(', ');
}

/** Where a tool comes from: the gateway's catalog first, else the server that lists it in its status. */
export function toolOrigin(tool: ToolInfo, catalog?: ToolCatalog): { server?: string; description?: string; schema?: Record<string, unknown> } {
  const entry = catalog?.tools?.get(tool.name);
  return { server: entry?.serverName ?? tool.server, description: entry?.description ?? tool.description, schema: entry?.inputSchema };
}

/** Where a tool page's facts come from: the gateway's catalog, or why it could not be read. */
function catalogLine(catalog?: ToolCatalog): string {
  if (catalog?.unreadable) return `The gateway's tool catalog could not be read: ${catalog.unreadable}.`;
  if (catalog?.gateway) return `From the tool catalog of gateway \`${catalog.gateway}\`, read through the Kubernetes service proxy.`;
  return "No tool catalog was read; what is shown comes from the MCP servers' status.";
}

/** A read-only Markdown page about one tool: where it comes from, what it does, who enables it, and its input schema. */
export function toolDocument(tool: ToolInfo, catalog?: ToolCatalog): string {
  const { server, description, schema } = toolOrigin(tool, catalog);
  const from = server ? `MCPServer \`${server}\`` : 'no MCP server of this crew lists it';
  const via = catalog?.gateway ? ` through gateway \`${catalog.gateway}\`` : '';
  const source = catalogLine(catalog);
  const schemaBlock = schema ? ['```json', JSON.stringify(schema, null, 2), '```'] : ['No input schema is known.'];
  return [
    `# Tool ${tool.name}`,
    '',
    `_Read-only. ${source}_`,
    '',
    `- From: ${from}${via}`,
    `- Enabled by: ${tool.agents.join(', ')}`,
    '',
    '## Description',
    '',
    description ?? 'No description is known.',
    '',
    '## Input schema',
    '',
    ...schemaBlock,
    '',
  ].join('\n');
}
