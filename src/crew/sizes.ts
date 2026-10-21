/**
 * The words the cluster's model catalog describes a model with, as Kubemoot's scheduler
 * reads them: a size class derived from the total parameter count, and abilities, each
 * a `capability/<name>: "true"` label. The size boundaries are Kubemoot's constants, so a
 * class means the same on every cluster.
 */

/** The label that carries a model's size class. */
export const SIZE_LABEL = 'kubemoot.ai/size';

/** The prefix of an ability's label: `capability/tool-calling`. */
export const CAPABILITY_PREFIX = 'capability/';

/** The retired label that stood for size and speed at once; a crew's own Models may still carry it. */
export const LEGACY_LATENCY_LABEL = 'latencyClass';

export type Size = 'small' | 'medium' | 'large';

/**
 * Where the size classes start, in total parameters: Kubemoot's SizeMediumFrom and
 * SizeLargeFrom (operator/api/v1alpha1/catalog.go), so a class here means what the
 * scheduler means by it.
 */
const MEDIUM_FROM = 12e9;
const LARGE_FROM = 30e9;

/** A parameter count in billions, as people write it: 12B. */
const billions = (n: number): string => `${n / 1e9}B`;

/** The size classes, smallest first, with the parameter counts each covers. */
export const SIZES: readonly { size: Size; covers: string }[] = [
  { size: 'small', covers: `under ${billions(MEDIUM_FROM)} parameters` },
  { size: 'medium', covers: `${billions(MEDIUM_FROM)} up to ${billions(LARGE_FROM)} parameters` },
  { size: 'large', covers: `${billions(LARGE_FROM)} parameters and over` },
];

/** The abilities a model can have, as the catalog's labels and Model.spec.capabilities name them. */
export const ABILITIES: readonly string[] = ['tool-calling', 'reasoning', 'vision'];

/** The ability a `capability/<name>` label says a model has, or undefined; YAML's unquoted true counts as "true". */
export function abilityOfLabel(key: string, value: unknown): string | undefined {
  return key.startsWith(CAPABILITY_PREFIX) && (value === 'true' || value === true) ? key.slice(CAPABILITY_PREFIX.length) : undefined;
}

const UNITS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** The form Model.spec.parameters takes: a number and a unit letter, such as 14B, 0.5B, or 751M. */
export const PARAMETERS_PATTERN = /^\d+(\.\d+)?[KMBT]$/i;

/** A parameter count such as "14B" or "0.5b" as a number; undefined when it is not one. */
export function parameterCount(value: string): number | undefined {
  const s = value.trim().toUpperCase();
  if (!PARAMETERS_PATTERN.test(s)) return undefined;
  const n = Number(s.slice(0, -1)) * UNITS[s.slice(-1)];
  return n > 0 ? n : undefined;
}

/** The size class of a model with this parameter count; undefined when the count is not one. */
export function sizeClassFor(parameters: string): Size | undefined {
  const n = parameterCount(parameters);
  if (n === undefined) return undefined;
  if (n < MEDIUM_FROM) return 'small';
  return n < LARGE_FROM ? 'medium' : 'large';
}

/** The size a retired latencyClass value stood for, as the scheduler reads it: low small, medium medium, high large. */
export function sizeOfLatencyClass(value: unknown): Size | undefined {
  const sizes: Record<string, Size> = { low: 'small', medium: 'medium', high: 'large' };
  return typeof value === 'string' ? sizes[value] : undefined;
}

/** Whether a value is one of the size classes. */
export const isSize = (value: unknown): value is Size => SIZES.some((s) => s.size === value);
