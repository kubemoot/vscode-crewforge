import { sourceOf, type SourceEntry } from '../source/service';
import type { DeclaredItem, Declarations } from '../source/declared';
import { declSites, TARGET_OF, type RefField, type RefSite, type RefTarget, type TextSpan } from './references';

/** Where an object is declared: its file and the line it starts at. */
export interface Place {
  file: string;
  line: number;
}

/** What one crew source declares that other objects name: its PromptModules and its Crew. */
export interface SourceNames {
  root: string;
  prompts: Map<string, Place & { detail?: string }>;
  crew?: Place & { name: string };
  /** Every file the source declares objects in: where a reference can be written. */
  files: string[];
}

export interface IndexDeps {
  entries: () => SourceEntry[];
  declarations: (entry: SourceEntry) => Promise<Declarations>;
}

/** The names a source declares, from what its declarations already hold (src/source/declared.ts). */
export function namesOf(root: string, declared: Declarations): SourceNames {
  const items = declared.sections.flatMap((s) => s.items);
  const prompts = new Map<string, Place & { detail?: string }>();
  const prompt = declared.sections.find((s) => s.section === 'prompts')?.items ?? [];
  for (const item of prompt) if (isDeclaredHere(item)) prompts.set(item.label, { file: item.file as string, line: item.line, detail: item.description });
  const crew = declared.crew?.file ? { name: declared.crew.label, file: declared.crew.file, line: declared.crew.line } : undefined;
  const files = new Set(items.map((i) => i.file).filter((f): f is string => Boolean(f)));
  if (crew) files.add(crew.file);
  return { root, prompts, crew, files: [...files] };
}

/** An item the source declares, as opposed to one it names that lives elsewhere. */
const isDeclaredHere = (item: DeclaredItem): boolean => item.object !== undefined && item.file !== undefined;

/**
 * The names of the crew source a file belongs to, read once and kept until the sources
 * load again. A source that fails to render has no names, so nothing is said about its
 * references: the render error is already the problem.
 */
export class ReferenceIndex {
  private readonly cache = new Map<string, Promise<SourceNames | undefined>>();

  constructor(private readonly deps: IndexDeps) {}

  namesFor(file: string): Promise<SourceNames | undefined> {
    const entry = sourceOf(this.deps.entries(), file);
    if (!entry) return Promise.resolve(undefined);
    const root = entry.source.root;
    let names = this.cache.get(root);
    if (!names) {
      names = this.deps.declarations(entry).then((d) => namesOf(root, d), () => undefined);
      this.cache.set(root, names);
    }
    return names;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

/** A problem with a reference: the site it is at and what is wrong. */
export interface Dangling {
  site: RefSite;
  message: string;
}

/** The references whose target the source does not declare. */
export function dangling(names: SourceNames, sites: RefSite[]): Dangling[] {
  return sites.flatMap((site): Dangling[] => {
    const problem = problemWith(names, site);
    return problem ? [{ site, message: problem }] : [];
  });
}

function problemWith(names: SourceNames, site: RefSite): string | undefined {
  if (site.field === 'promptRefs') {
    return names.prompts.has(site.name) ? undefined : `PromptModule "${site.name}" is not declared in this crew source. It must be installed in the cluster, or this is a misspelling.`;
  }
  return !names.crew || names.crew.name === site.name ? undefined : `This crew source declares the Crew "${names.crew.name}", not "${site.name}".`;
}

/** Where the object a reference names is declared; undefined when this source does not declare it. */
export function targetOf(names: SourceNames, field: RefField, name: string): Place | undefined {
  if (field === 'promptRefs') return names.prompts.get(name);
  return names.crew?.name === name ? names.crew : undefined;
}

/** The names a reference field accepts here, each with what it is. */
export function candidates(names: SourceNames, field: RefField): { name: string; detail?: string }[] {
  if (field === 'crewRef') return names.crew ? [{ name: names.crew.name, detail: 'Crew' }] : [];
  return [...names.prompts].map(([name, p]) => ({ name, detail: p.detail })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Where `name` is written in the declaration of `place`: its `name:` value, else the line the object starts at. */
export function declarationSpan(text: string, place: Place, field: RefField, name: string): TextSpan {
  const kind: RefTarget = TARGET_OF[field];
  const site = declSites(text).find((s) => s.kind === kind && s.name === name && s.line >= place.line);
  return site ?? { line: place.line, start: 0, end: 0 };
}
