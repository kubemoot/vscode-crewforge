import { isKubemoot, objectKey, type Manifest } from './manifests';

export type DriftState = 'in-sync' | 'changed' | 'missing' | 'extra';

/** How one Kubemoot object in the source compares with the cluster. */
export interface ResourceDrift {
  kind: string;
  name: string;
  state: DriftState;
  /** The spec fields that differ, as dotted paths (changed objects only). */
  paths: string[];
  rendered?: Manifest;
  live?: Manifest;
}

/**
 * Compares the Kubemoot objects a source renders with the live ones. Only `spec` is
 * compared, and only the fields the source sets: the API server fills defaults, and
 * labels carry build versions that differ between a local render and a release.
 * `live` should hold the crew's objects of the rendered kinds; a live object the
 * source no longer renders is reported as extra.
 */
export function compare(rendered: Manifest[], live: Manifest[]): ResourceDrift[] {
  const wanted = rendered.filter(isKubemoot);
  const liveByKey = new Map(live.map((m) => [objectKey(m), m]));
  const result = wanted.map((r) => compareOne(r, liveByKey.get(objectKey(r))));
  const renderedKeys = new Set(wanted.map(objectKey));
  for (const m of live) {
    if (!renderedKeys.has(objectKey(m))) result.push({ kind: m.kind, name: m.metadata.name, state: 'extra', paths: [], live: m });
  }
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function compareOne(rendered: Manifest, live: Manifest | undefined): ResourceDrift {
  const base = { kind: rendered.kind, name: rendered.metadata.name, rendered, live };
  if (!live) return { ...base, state: 'missing', paths: [] };
  const paths = differences(rendered.spec, live.spec, 'spec');
  return { ...base, state: paths.length ? 'changed' : 'in-sync', paths };
}

/** The paths where `want` sets a value that `have` does not match; fields `want` leaves out are ignored. */
export function differences(want: unknown, have: unknown, at: string): string[] {
  if (want === null || want === undefined) return [];
  if (Array.isArray(want)) return arrayDifferences(want, have, at);
  if (typeof want === 'object') return objectDifferences(want as Record<string, unknown>, have, at);
  return sameScalar(want, have) ? [] : [at];
}

function arrayDifferences(want: unknown[], have: unknown, at: string): string[] {
  if (!Array.isArray(have) || have.length !== want.length) return [at];
  return want.flatMap((w, i) => differences(w, have[i], `${at}[${i}]`));
}

function objectDifferences(want: Record<string, unknown>, have: unknown, at: string): string[] {
  if (!have || typeof have !== 'object' || Array.isArray(have)) return [at];
  const other = have as Record<string, unknown>;
  return Object.entries(want).flatMap(([key, value]) => differences(value, other[key], `${at}.${key}`));
}

/** YAML and JSON disagree on some scalars (a quantity written 2 comes back "2"); compare their text. */
function sameScalar(want: unknown, have: unknown): boolean {
  return want === have || (have !== undefined && have !== null && String(want) === String(have));
}

/** Counts per state, for a one-line summary. */
export function summarize(drift: ResourceDrift[]): string {
  const counts = { changed: 0, missing: 0, extra: 0 };
  for (const d of drift) if (d.state !== 'in-sync') counts[d.state]++;
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`);
  return parts.length ? parts.join(', ') : 'in sync';
}
