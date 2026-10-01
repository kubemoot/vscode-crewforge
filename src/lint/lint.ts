import * as path from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { keyLine, locate, type Located } from '../source/locate';
import { isKubemoot, objectKey, type Manifest } from '../source/manifests';
import { helmErrorLocation, RenderError, renderWithOrigins, type Exec, type RenderDeps } from '../source/render';
import type { CrewSource } from '../source/discover';
import { errorText } from '../views/errors';

export type Severity = 'error' | 'warning' | 'info';

/** One problem Lint found, at a file and line (0-based). */
export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
  /** What found it: helm lint, the render, or the Kubemoot schema. */
  source: 'helm lint' | 'render' | 'schema';
}

export interface LintResult {
  findings: Finding[];
  /** What the lint could not check, in plain words, such as a schema it could not read. */
  notes: string[];
}

export interface LintDeps extends RenderDeps {
  readText: (file: string) => Promise<string>;
  /** The Kubemoot JSON Schema as text; `{}` when the cluster cannot be read. */
  schema: () => Promise<string>;
}

/** Thrown when a tool Lint needs is not on the PATH. */
export class MissingToolError extends Error {}

export const HELM_INSTALL = 'https://helm.sh/docs/intro/install/';

/** The namespace a source is rendered into for linting. */
const LINT_NAMESPACE = 'default';

/**
 * Lints a crew source: `helm lint` for a chart, then a render of every object, each
 * Kubemoot object checked against the cluster's Kubemoot schemas. A render that fails
 * is a finding at the place it points to, and ends the lint there.
 */
export async function lintSource(source: CrewSource, deps: LintDeps, namespace = LINT_NAMESPACE): Promise<LintResult> {
  const findings = source.kind === 'helm' ? await helmLint(source.root, deps.exec) : [];
  let located: Located[];
  try {
    located = await locate(await renderWithOrigins(source, { namespace }, deps), deps.readText);
  } catch (err) {
    return { findings: [...findings, renderFinding(source, err)], notes: [] };
  }
  const validate = compiled(await deps.schema());
  if (!validate) return { findings, notes: ['The Kubemoot schema check was skipped: CrewForge could not read the schemas from the cluster.'] };
  const schemaFindings = await Promise.all(located.filter((l) => isKubemoot(l.manifest) && l.file).map((l) => checkObject(l, validate, deps.readText)));
  return { findings: [...findings, ...schemaFindings.flat()], notes: [] };
}

/** Runs `helm lint` on a chart and reads its findings. */
async function helmLint(root: string, exec: Exec): Promise<Finding[]> {
  const result = await exec('helm', ['lint', root], { cwd: path.dirname(root) });
  if (result.code === 127) throw new MissingToolError(`Lint needs helm on your PATH to lint a Helm chart, and none was found. Install it from ${HELM_INSTALL}`);
  const findings = parseHelmLint(root, `${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 && !findings.some((f) => f.severity === 'error')) {
    findings.push({ file: path.join(root, 'Chart.yaml'), line: 0, severity: 'error', message: `helm lint failed: ${(result.stderr || result.stdout).trim()}`, source: 'helm lint' });
  }
  return findings;
}

const LINT_LINE = /^\[(ERROR|WARNING|INFO)\] ([^:]+): (.*)$/;
const SEVERITIES: Record<string, Severity> = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/** The findings in `helm lint` output: `[ERROR] templates/: parse error at (chart/templates/x.yaml:5): ...`. */
export function parseHelmLint(root: string, output: string): Finding[] {
  return output.split('\n').flatMap((line): Finding[] => {
    const m = LINT_LINE.exec(line.trim());
    if (!m) return [];
    const [, level, where, message] = m;
    const at = helmErrorLocation(root, message) ?? { file: where.endsWith('/') ? path.join(root, 'Chart.yaml') : path.join(root, where), line: 0 };
    return [{ ...at, severity: SEVERITIES[level], message, source: 'helm lint' }];
  });
}

function renderFinding(source: CrewSource, err: unknown): Finding {
  const message = errorText(err);
  const fallback = source.kind === 'helm' ? path.join(source.root, 'Chart.yaml') : source.root;
  const at = err instanceof RenderError ? { file: err.file ?? fallback, line: err.line ?? 0 } : { file: fallback, line: 0 };
  return { ...at, severity: 'error', message, source: 'render' };
}

let cache: { text: string; validate?: ValidateFunction } | undefined;

/** The schema compiled once per schema text; undefined when there is no schema to check against. */
export function compiled(text: string): ValidateFunction | undefined {
  if (cache?.text === text) return cache.validate;
  const schema = JSON.parse(text) as { allOf?: unknown[] };
  const validate = schema.allOf?.length ? new Ajv({ strict: false, allErrors: true }).compile(schema) : undefined;
  cache = { text, validate };
  return validate;
}

async function checkObject(l: Located, validate: ValidateFunction, readText: (file: string) => Promise<string>): Promise<Finding[]> {
  if (validate(l.manifest)) return [];
  // Ajv keeps the last call's errors on the shared function; other objects validate
  // while this one awaits its file, so copy them before the await.
  const errors = [...(validate.errors ?? [])];
  const file = l.file as string;
  const text = await readText(file).catch(() => '');
  return schemaIssues(l.manifest, errors).map(({ keys, message }) => ({ file, line: keyLine(text, l.line, keys), severity: 'error', message, source: 'schema' }));
}

/**
 * Ajv's errors as one plain line each, with the keys that lead to the offending field.
 * The if/then wrappers of the schema say nothing on their own and are left out.
 */
export function schemaIssues(m: Manifest, errors: ErrorObject[]): { keys: string[]; message: string }[] {
  return errors
    .filter((e) => e.keyword !== 'if')
    .map((e) => {
      const keys = e.instancePath.split('/').filter(Boolean);
      const field = keys.length ? fieldPath(keys) : 'the object';
      const extra = e.keyword === 'additionalProperties' ? String((e.params as { additionalProperty?: unknown }).additionalProperty) : undefined;
      const message = extra
        ? `${objectKey(m)}: ${field} has no field "${extra}"; the API server would drop it.`
        : `${objectKey(m)}: ${field} ${e.message ?? 'is not valid'}.`;
      return { keys: extra ? [...keys, extra] : keys, message };
    });
}

/** `spec.mcpServers[1].name` from its JSON pointer segments. */
function fieldPath(keys: string[]): string {
  return keys.map(pathSegment).join('');
}

/** One segment of a field path: `[1]` for an index, `.name` for a key after the first, `spec` for the first. */
function pathSegment(key: string, index: number): string {
  if (/^\d+$/.test(key)) return `[${key}]`;
  return index ? `.${key}` : key;
}
