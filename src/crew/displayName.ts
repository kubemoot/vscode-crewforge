/**
 * A crew has two names. Its technical name (the Crew's metadata.name) is a DNS-1123 label
 * that Kubernetes names the crew's objects after. Its display name is the name people
 * read, any one line of text, kept in the Crew's `kubemoot.ai/display-name` annotation;
 * without one, people read the technical name.
 */

export const DISPLAY_NAME_ANNOTATION = 'kubemoot.ai/display-name';

/**
 * The longest technical name: the operator names the starter crew's tool index Service
 * `<crew>-kubernetes-mcp-tools-query`, a DNS label of at most 63 characters. Matches kmctl's
 * scaffold.MaxNameLength, and is under Helm's 53-character limit for a release name.
 */
export const MAX_CREW_NAME = 63 - '-kubernetes-mcp-tools-query'.length;

/** The longest display name, in characters. Matches kmctl's scaffold.MaxDisplayNameLength. */
export const MAX_DISPLAY_NAME = 100;

/** A crew name when nothing of the display name can be kept. */
const FALLBACK_NAME = 'crew';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Letters that do not decompose into an ASCII letter and accents, spelled in ASCII. */
const SPELLED: Record<string, string> = {
  '\u00df': 'ss', // sharp s
  '\u00e6': 'ae', // ae ligature
  '\u0153': 'oe', // oe ligature
  '\u00f8': 'o', // o with stroke
  '\u0142': 'l', // l with stroke
  '\u0111': 'd', // d with stroke
  '\u00f0': 'd', // eth
  '\u00fe': 'th', // thorn
  '\u0131': 'i', // dotless i
};

/** Anything with a name and, maybe, annotations: a live Crew's summary, or a rendered Crew's metadata. */
export interface Named {
  name: string;
  annotations?: Record<string, string>;
}

/** The display name an annotation map holds, trimmed; undefined when it holds none. */
export function displayNameIn(annotations: Record<string, string> | undefined): string | undefined {
  return annotations?.[DISPLAY_NAME_ANNOTATION]?.trim() || undefined;
}

/** The name people read for a live crew: its display name, else its technical name. */
export function titleOf(crew: Named): string {
  return crewTitle({ crew });
}

/** What a crew is known by where both a source and a live Crew may say: the source's display name, the live Crew's, then a name. */
export interface TitleSources {
  entry?: { displayName?: string; crewName?: string; source: { label: string } };
  crew?: Named;
}

/**
 * The one rule for the name people read for a crew: the display name its source renders,
 * else the live Crew's, else its technical name (the source's, then the live Crew's), else
 * the source folder's name.
 */
export function crewTitle({ entry, crew }: TitleSources): string {
  return entry?.displayName ?? displayNameIn(crew?.annotations) ?? technicalName({ entry, crew });
}

/** The technical name: the source's Crew's, else the live Crew's, else the source folder's. */
export function technicalName({ entry, crew }: TitleSources): string {
  return entry?.crewName ?? crew?.name ?? entry?.source.label ?? '';
}

/**
 * The technical name a display name suggests: lowercase, accented letters as plain ASCII
 * letters, every run of anything else as one hyphen, no hyphen at either end, at most
 * MAX_CREW_NAME characters, and `crew` when nothing is left.
 * "Homelab Health Guide" becomes homelab-health-guide; "Lab-Ops Crew #2", lab-ops-crew-2.
 */
export function deriveCrewName(display: string): string {
  return dnsLabel(display, MAX_CREW_NAME) || FALLBACK_NAME;
}

/**
 * Text as a DNS label of at most `max` characters: lowercase, accented letters as plain
 * ASCII letters, every run of anything else as one hyphen, no hyphen at either end; empty
 * when nothing is left.
 */
export function dnsLabel(text: string, max: number): string {
  const ascii = text
    .toLowerCase()
    .replaceAll(/./gu, (ch) => SPELLED[ch] ?? ch)
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '');
  const hyphenated = ascii.replaceAll(/[^a-z0-9]+/g, '-');
  return trimHyphens(trimHyphens(hyphenated).slice(0, max));
}

/** text without hyphens at either end, in one pass. */
function trimHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '-') start++;
  while (end > start && text[end - 1] === '-') end--;
  return text.slice(start, end);
}

/** Why value cannot be a crew's technical name, in plain words; undefined when it can. */
export function crewNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (name === '') return 'Enter a name.';
  if (!DNS_LABEL.test(name)) return "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit; it becomes the Kubernetes name of the crew's objects.";
  if (name.length > MAX_CREW_NAME) return `Keep it to ${MAX_CREW_NAME} characters (it has ${name.length}), so the names Kubernetes builds on it fit.`;
  return undefined;
}

/** Half of a UTF-16 surrogate pair without its other half: not a character. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why value cannot be a display name, in plain words; undefined when it can. */
export function displayNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (name === '') return 'Enter a name.';
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return 'Keep it to one line, without tabs.';
  if (LONE_SURROGATE.test(name)) return 'Use only whole characters.';
  const length = [...name].length;
  if (length > MAX_DISPLAY_NAME) return `Keep it to ${MAX_DISPLAY_NAME} characters (it has ${length}).`;
  return undefined;
}
