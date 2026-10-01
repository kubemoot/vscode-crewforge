import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { SourceService, type SourceDeps } from '../src/source/service';
import { CrewTreeProvider, sourceText, type CrewNode } from '../src/views/crewTree';
import { SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { FakeCluster, obj, seedCrew } from './fakeCluster';
import { resetFake } from './vscodeFake';

/** "Crew" or "crew" leading a label inside CrewForge's own views, where the view already says it. */
const LEADING_CREW = /^crew /i;

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string }[]> };
};

const RENDERED = ['apiVersion: kubemoot.ai/v1alpha1', 'kind: Crew', 'metadata:', '  name: grade', 'spec:', '  description: Grades answers'].join('\n');

const deps: SourceDeps = {
  exec: async (cmd) => (cmd === 'git' ? { code: 128, stdout: '', stderr: 'not a repo' } : { code: 0, stdout: RENDERED, stderr: '' }),
  readText: async () => RENDERED,
  readYamlFiles: async () => [],
  listFiles: async () => ({ charts: ['/w/grade/Chart.yaml'], yamls: ['/w/grade/templates/crew.yaml'] }),
};

/** Every item a tree shows, depth first, to `depth` levels. */
async function items<T>(tree: { getChildren(n?: T): Promise<T[]>; getTreeItem(n: T): { label?: unknown; description?: unknown } }, depth = 3, node?: T): Promise<{ label?: unknown; description?: unknown }[]> {
  if (depth === 0) return [];
  const children = await tree.getChildren(node);
  const nested = await Promise.all(children.map((c) => items(tree, depth - 1, c)));
  return [...children.map((c) => tree.getTreeItem(c)), ...nested.flat()];
}

beforeEach(resetFake);

describe('the word "Crew" inside CrewForge views', () => {
  it('does not lead a command title, so no menu entry in the views reads "Crew ..."', () => {
    const viewMenus = new Set(manifest.contributes.menus['view/item/context'].map((m) => m.command));
    const leading = manifest.contributes.commands.filter((c) => LEADING_CREW.test(c.title)).map((c) => c.command);
    expect(leading).toEqual([]);
    expect(viewMenus.size).toBeGreaterThan(10);
  });

  it('does not lead a label or description in Deployed Crews', async () => {
    const cluster = seedCrew(new FakeCluster());
    const tree = new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    tree.sourceOpen = () => false;
    const shown = await items<CrewNode>(tree);
    expect(shown.length).toBeGreaterThan(5);
    for (const item of shown) {
      expect(String(item.label)).not.toMatch(LEADING_CREW);
      expect(String(item.description ?? '')).not.toMatch(LEADING_CREW);
    }
  });

  it('does not lead a label or description in Crew Sources; a source reads as its crew name', async () => {
    const cluster = new FakeCluster().add(obj('Crew', 'grade', 'crew-grade'));
    const tree = new SourceTreeProvider(new SourceService(deps), () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    tree.stateOf = () => ({ text: 'deployed in crew-grade, changed', changed: true });
    const shown = await items<SourceNode>(tree);
    expect(shown[0]).toMatchObject({ label: 'grade', description: 'deployed in crew-grade, changed · helm' });
    for (const item of shown) {
      expect(String(item.label)).not.toMatch(LEADING_CREW);
      expect(String(item.description ?? '')).not.toMatch(LEADING_CREW);
    }
  });

  it('says whether a live crew has a local source', () => {
    expect(sourceText(true)).toBe(' · source open');
    expect(sourceText(false)).toBe(' · no local source');
    expect(sourceText(undefined)).toBe('');
  });
});
