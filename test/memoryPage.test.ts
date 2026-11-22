import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMemoryPage, type MemoryView } from '../src/dashboard/memoryPage';
import { exportFileName, MemoryDashboard } from '../src/dashboard/memoryDashboard';
import { Dashboards } from '../src/dashboard/register';
import { ConnectionError } from '../src/k8s/request';
import type { MemoryConnection } from '../src/memory/connect';
import { parseExport, parseReport } from '../src/memory/ompi';
import { META_SEPARATOR } from '../src/webview/render';
import { MemoryError, type MemoryRead } from '../src/memory/relay';
import { recorded, resetFake, Uri } from './vscodeFake';

const zip = fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-export.zip'));
const report = parseReport(fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-report.json'), 'utf8'))!;
const read: MemoryRead = { zip, parsed: parseExport(zip), report };
const view: MemoryView = { crew: 'demo', title: 'Demo', namespace: 'crew-demo', context: 'lab', parsed: read.parsed, report };

describe('renderMemoryPage', () => {
  const html = renderMemoryPage(view);

  it('groups the facts by topic with value, writer, time and thread', () => {
    expect(html).toContain('cluster (2)');
    expect(html).toContain('preferences (1)');
    expect(html).toContain('coordinator');
    expect(html).toContain('datetime="2026-11-18T10:00:00Z"');
    expect(html).toContain('<span title="Learned in the Moot thread-abc"><time datetime="2026-11-18T10:00:00Z" title="2026-11-18T10:00:00Z">');
    expect(html).not.toContain('<th>Thread</th>');
    expect(html).toContain(`3 facts${META_SEPARATOR}read-only${META_SEPARATOR}exported`);
    expect(html).toContain('title="crew-demo/demo, OMPI protocol');
  });

  it('escapes a fact value', () => {
    expect(html).toContain('5 nodes &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('shows the left-out entries as counts and reasons, with no key or text', () => {
    expect(html).toContain('3 entries left out of the export');
    expect(html).toMatch(/its value holds a credential \(bearer token\); not exported as memory<\/td><td>2</);
    expect(html).toMatch(/its topic or key holds a credential; not exported as memory<\/td><td>1</);
    expect(html).not.toContain('crew-demo.demo');
    expect(html).not.toContain('#1a2b3c4d');
  });

  it('says nothing was left out when the export is whole', () => {
    const whole = renderMemoryPage({ ...view, report: { memories: 3, leftOut: [] }, parsed: { ...read.parsed, manifest: { ...read.parsed.manifest, skipped: 0 } } });
    expect(whole).toContain('Nothing was left out of the export.');
  });

  it('counts the left-out entries from the manifest when there is no report', () => {
    const noReport = renderMemoryPage({ ...view, report: undefined });
    expect(noReport).toContain('2 entries left out of the export');
    expect(noReport).not.toContain('<th>Reason</th>');
  });

  it('says so when the crew has learned nothing', () => {
    expect(renderMemoryPage({ ...view, parsed: { ...read.parsed, facts: [] } })).toContain('This crew has learned no facts yet.');
  });

  it('shows an error with Refresh, Export disabled, and Select Kubernetes Context for a connection problem', () => {
    const failed = renderMemoryPage({ crew: 'demo', title: 'Demo', namespace: 'n', context: 'lab', error: 'It <broke>', contextProblem: true });
    expect(failed).toContain('It &lt;broke&gt;');
    expect(failed).toContain('data-action="refresh"');
    expect(failed).toContain('data-action="selectContext"');
    expect(failed).toMatch(/data-action="exportZip"[^>]*disabled/);
  });
});

describe('MemoryDashboard', () => {
  let dir: string;
  let reads: number;
  let failure: Error | undefined;
  const connect = (): MemoryConnection => ({
    context: 'lab',
    config: {} as never,
    relay: {
      read: async () => {
        reads++;
        if (failure) throw failure;
        return read;
      },
    } as never,
  });

  beforeEach(() => {
    resetFake();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-memory-'));
    reads = 0;
    failure = undefined;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const crew = { name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready' } as never;

  it('reads on render and not on a timer', async () => {
    const page = new MemoryDashboard(crew, connect);
    expect(await page.render()).toContain('cluster (2)');
    expect(page.refreshMs()).toBeUndefined();
    expect(page.title()).toBe('demo memory');
    await page.actions.refresh();
    await page.render();
    expect(reads).toBe(2);
  });

  it('shows the plain message of a refusal and offers a context only for a connection problem', async () => {
    failure = new MemoryError('Reading the memory of crew demo needs get on the Crew demo.', 403);
    const refused = await new MemoryDashboard(crew, connect).render();
    expect(refused).toContain('needs get on the Crew demo');
    expect(refused).not.toContain('selectContext');
    failure = new ConnectionError('Cannot reach the operator.');
    expect(await new MemoryDashboard(crew, connect).render()).toContain('selectContext');
  });

  it('Select Kubernetes Context runs the command', async () => {
    await new MemoryDashboard(crew, connect).actions.selectContext();
    expect(recorded.executed.map((e) => e.id)).toContain('crewforge.selectContext');
  });

  it('exports the zip it read into the picked folder, and never overwrites a file', async () => {
    const page = new MemoryDashboard(crew, connect);
    await page.render();
    recorded.openDialog = [Uri.file(dir)];
    await page.actions.exportZip();
    const target = path.join(dir, exportFileName('demo'));
    expect(fs.readFileSync(target).equals(zip)).toBe(true);
    expect(recorded.info.at(-1)).toContain(target);
    await page.actions.exportZip();
    expect(recorded.errors.at(-1)).toMatch(/already exists/);
  });

  it('exports nothing before a read has succeeded, or when no folder is picked', async () => {
    const page = new MemoryDashboard(crew, connect);
    recorded.openDialog = [Uri.file(dir)];
    await page.actions.exportZip();
    await page.render();
    recorded.openDialog = undefined;
    await page.actions.exportZip();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('Dashboards.openMemory', () => {
  it('opens one page per crew from a crew node and ignores a node that is not a crew', () => {
    resetFake();
    const dashboards = new Dashboards({ extensionUri: { fsPath: '/ext' }, crewforgeVersion: '0', connect: () => ({}) } as never);
    const crew = { name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready' } as never;
    dashboards.openMemory({ kind: 'crew', crew });
    dashboards.openMemory({ kind: 'crew', crew });
    expect(recorded.panels.filter((p) => p.title === 'demo memory')).toHaveLength(1);
    expect(dashboards.openMemory({ kind: 'message', text: 'x' } as never)).toBeUndefined();
    expect(dashboards.openMemory()).toBeUndefined();
    for (const p of recorded.panels) p.dispose();
  });
});
