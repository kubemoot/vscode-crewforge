import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { metaOf, type Conversation, type ConversationMeta } from './conversation';

/** What names a saved conversation's file. */
type ConversationKey = Pick<Conversation, 'context' | 'namespace' | 'crewName' | 'id'>;

/**
 * Saved conversations, one JSON file each, at
 * `<root>/<context>/<namespace>/<crew>/<id>.json`.
 */
export class ConversationStore {
  constructor(readonly root: string) {}

  dir(context: string, namespace: string, crew: string): string {
    return path.join(this.root, safeSegment(context), safeSegment(namespace), safeSegment(crew));
  }

  file(c: ConversationKey): string {
    return path.join(this.dir(c.context, c.namespace, c.crewName), `${safeSegment(c.id)}.json`);
  }

  /** Writes the conversation through a temporary file, so a crash never leaves half a file. */
  async save(c: Conversation): Promise<void> {
    const target = this.file(c);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(c, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  async load(c: ConversationKey): Promise<Conversation> {
    return JSON.parse(await fs.readFile(this.file(c), 'utf8')) as Conversation;
  }

  /** Deletes a saved conversation; one never saved is already gone. */
  async remove(c: ConversationKey): Promise<void> {
    await fs.rm(this.file(c), { force: true });
  }

  /** One crew's conversations, newest first. Files that cannot be read are left out. */
  async list(context: string, namespace: string, crew: string): Promise<ConversationMeta[]> {
    return newestFirst(await readDir(this.dir(context, namespace, crew)));
  }

  /** Every saved conversation, newest first. */
  async listAll(): Promise<ConversationMeta[]> {
    const dirs = await subdirs(this.root, 3);
    const lists = await Promise.all(dirs.map(readDir));
    return newestFirst(lists.flat());
  }
}

/** A path segment that cannot climb out of its directory or trip a file system. */
export function safeSegment(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' || /^\.+$/.test(cleaned) ? '_' : cleaned;
}

async function readDir(dir: string): Promise<ConversationMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readMeta(path.join(dir, n))));
  return metas.filter((m): m is ConversationMeta => m !== undefined);
}

async function readMeta(file: string): Promise<ConversationMeta | undefined> {
  try {
    const c = JSON.parse(await fs.readFile(file, 'utf8')) as Conversation;
    return c && typeof c.id === 'string' && typeof c.crewName === 'string' ? metaOf(c) : undefined;
  } catch {
    return undefined;
  }
}

async function subdirs(dir: string, depth: number): Promise<string[]> {
  if (depth === 0) return [dir];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => subdirs(path.join(dir, e.name), depth - 1)));
  return nested.flat();
}

function newestFirst(metas: ConversationMeta[]): ConversationMeta[] {
  return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
