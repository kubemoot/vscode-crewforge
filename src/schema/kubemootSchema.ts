/** The API server's OpenAPI v3 document for the Kubemoot group, as served at /openapi/v3/apis/kubemoot.ai/v1alpha1. */
export const OPENAPI_PATH = '/openapi/v3/apis/kubemoot.ai/v1alpha1';

type JsonObject = Record<string, unknown>;

interface OpenApiDocument {
  components?: { schemas?: Record<string, JsonObject> };
}

interface GroupVersionKind {
  group: string;
  version: string;
  kind: string;
}

const REF_PREFIX = '#/components/schemas/';

/**
 * A JSON Schema for YAML files holding Kubemoot objects, built from the cluster's own
 * OpenAPI, so it always matches the operator that is installed. Each Kubemoot kind is
 * one if/then rule, so a file may mix kinds, and objects of other kinds pass untouched.
 * Objects are strict: a field the CRD does not define is an error, because the API
 * server would silently drop it.
 */
export function buildSchema(openapi: OpenApiDocument): JsonObject {
  const schemas = openapi.components?.schemas ?? {};
  const definitions: Record<string, unknown> = {};
  const rules: JsonObject[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    definitions[name] = strict(rewriteRefs(schema));
    const gvk = kindOf(schema);
    if (gvk?.group === 'kubemoot.ai' && !gvk.kind.endsWith('List')) rules.push(rule(gvk, name));
  }
  return { $schema: 'http://json-schema.org/draft-07/schema#', title: 'Kubemoot resources', allOf: rules, definitions };
}

function kindOf(schema: JsonObject): GroupVersionKind | undefined {
  const gvks = schema['x-kubernetes-group-version-kind'];
  return Array.isArray(gvks) && gvks.length === 1 ? (gvks[0] as GroupVersionKind) : undefined;
}

function rule(gvk: GroupVersionKind, name: string): JsonObject {
  return {
    if: { required: ['apiVersion', 'kind'], properties: { apiVersion: { const: `${gvk.group}/${gvk.version}` }, kind: { const: gvk.kind } } },
    then: { $ref: `#/definitions/${name}` },
  };
}

/** Points OpenAPI component references at the schema's definitions. */
export function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const [key, inner] of Object.entries(value as JsonObject)) {
    out[key] = key === '$ref' && typeof inner === 'string' && inner.startsWith(REF_PREFIX) ? `#/definitions/${inner.slice(REF_PREFIX.length)}` : rewriteRefs(inner);
  }
  return out;
}

/** Closes every object schema that lists its properties, unless it declares that it keeps unknown fields. */
export function strict(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strict);
  if (!value || typeof value !== 'object') return value;
  const schema = value as JsonObject;
  const out: JsonObject = {};
  for (const [key, inner] of Object.entries(schema)) out[key] = strict(inner);
  if (closable(schema)) out.additionalProperties = false;
  return out;
}

function closable(schema: JsonObject): boolean {
  return (
    schema.properties !== undefined &&
    typeof schema.properties === 'object' &&
    schema.additionalProperties === undefined &&
    schema['x-kubernetes-preserve-unknown-fields'] !== true
  );
}

/** Whether a document is one the schema should check: Kubemoot objects, not a Helm template CrewForge cannot parse. */
export function wantsSchema(text: string): boolean {
  return /^apiVersion:\s*kubemoot\.ai\//m.test(text) && !text.includes('{{');
}
