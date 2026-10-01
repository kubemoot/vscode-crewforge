import type { Manifest } from '../source/manifests';

/** Narrowing for the untyped fields of Kubemoot objects, the one place each rule lives. */

/** A string that says something, or undefined for anything else (an empty string included). */
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The non-empty strings of a list; nothing for anything that is not a list. */
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []);

/** A map-like object, or an empty one for anything else. */
export const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** An object's spec as a map; empty when it has none. */
export const specOf = (m: Manifest): Record<string, unknown> => objectOf(m.spec);

/** The non-empty names of a list of `{name}` references, such as spec.ragSources or spec.mcpServers. */
export function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((r: { name?: unknown }) => r?.name).filter((n): n is string => typeof n === 'string' && n !== '') : [];
}

/** The trimmed, non-empty items of a comma-separated list. */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
