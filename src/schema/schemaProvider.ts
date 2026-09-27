import * as vscode from 'vscode';
import type { KubeTransport } from '../k8s/request';
import { buildSchema, OPENAPI_PATH, wantsSchema } from './kubemootSchema';

export const SCHEMA_SCHEME = 'crewforge-schema';
const EMPTY = '{}';

export const SCHEMA_URI = `${SCHEMA_SCHEME}://schemas/kubemoot.json`;

/** The part of the Red Hat YAML extension's API CrewForge uses. */
export interface YamlApi {
  registerContributor(schema: string, requestSchema: (resource: string) => string | undefined, requestSchemaContent: (uri: string) => Promise<string> | string, label?: string): boolean;
}

/**
 * Gives the YAML extension a schema for Kubemoot objects, fetched once per connection
 * from the cluster. Without the YAML extension installed there is nothing to do.
 */
export class SchemaProvider {
  private cached?: { client: KubeTransport; schema: Promise<string> };

  constructor(private readonly client: () => KubeTransport | undefined) {}

  async register(): Promise<boolean> {
    const extension = vscode.extensions.getExtension<YamlApi>('redhat.vscode-yaml');
    if (!extension) return false;
    const api = await extension.activate();
    return api.registerContributor(SCHEMA_SCHEME, (resource) => this.requestSchema(resource), () => this.schemaText(), 'Kubemoot (from the cluster)');
  }

  requestSchema(resource: string): string | undefined {
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === resource);
    return document && wantsSchema(document.getText()) ? SCHEMA_URI : undefined;
  }

  /** The schema text; an empty schema when the cluster cannot be reached, so the editor never blocks on it. */
  schemaText(): Promise<string> {
    const client = this.client();
    if (!client) return Promise.resolve(EMPTY);
    if (this.cached?.client !== client) {
      const schema = fetchSchema(client);
      this.cached = { client, schema };
      void schema.then((text) => {
        if (text === EMPTY && this.cached?.schema === schema) this.cached = undefined;
      });
    }
    return this.cached.schema;
  }
}

async function fetchSchema(client: KubeTransport): Promise<string> {
  try {
    return JSON.stringify(buildSchema(JSON.parse(await client.request('GET', OPENAPI_PATH))));
  } catch {
    return EMPTY;
  }
}
