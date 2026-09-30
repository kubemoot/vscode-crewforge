import * as vscode from 'vscode';
import type { CrewForgeApi } from '../../../src/extension';
import type { CrewNode } from '../../../src/views/crewTree';
import type { SourceNode } from '../../../src/views/sourceTree';

/** CrewForge, activated, as the integration tests see it. */
export async function crewforge(): Promise<CrewForgeApi> {
  const ext = vscode.extensions.getExtension<CrewForgeApi>('kubemoot.crewforge');
  if (!ext) throw new Error('CrewForge is not installed in this VS Code');
  return ext.activate();
}

/**
 * Waits until `check` returns a value, polling; fails after `ms` with what the last look
 * saw. The bound is a safety net: each check waits on a state, never on a time.
 */
export async function until<T>(what: string, check: () => T | undefined | Promise<T | undefined>, describe: () => unknown = () => undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last seen: ${JSON.stringify(describe(), null, 2)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Waits until the page with `key` shows text containing every one of `words`. */
export async function pageShows(api: CrewForgeApi, key: string, words: string[]): Promise<string> {
  return until(
    `page ${key} to show ${words.join(', ')}`,
    () => {
      const shown = api.pages().find((p) => p.key === key)?.shown;
      return shown && words.every((w) => shown.includes(w)) ? shown : undefined;
    },
    () => api.pages(),
  );
}

/** The live crew node for `namespace/name` in Deployed Crews. */
export async function liveCrew(api: CrewForgeApi, namespace: string, name: string): Promise<Extract<CrewNode, { kind: 'crew' }>> {
  return until(`${namespace}/${name} in Deployed Crews`, () => api.crews.nodeFor(namespace, name), () => api.crews.known);
}

/** The Crew Sources node of the source whose folder ends with `folder`. */
export async function sourceNode(api: CrewForgeApi, folder: string): Promise<Extract<SourceNode, { kind: 'source' }>> {
  return until(
    `the source ${folder} in Crew Sources`,
    async () => (await api.sources.getChildren()).find((n): n is Extract<SourceNode, { kind: 'source' }> => n.kind === 'source' && n.entry.source.root.endsWith(folder)),
    () => api.sources.known.map((e) => e.source.root),
  );
}

/** Closes every editor, so each test starts from an empty window. */
export async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
