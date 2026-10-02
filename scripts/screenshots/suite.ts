/**
 * Runs inside VS Code (started by run.ts): puts CrewForge in each state a picture needs and
 * captures it. Pictures are taken through VS Code's own debugging port, so they show the
 * window exactly as a person sees it, at a fixed 1400 x 900 size.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CrewForgeApi } from '../../src/extension';

const out = process.env.CREWFORGE_SHOTS_OUT ?? '';
const port = process.env.CREWFORGE_SHOTS_PORT ?? '9333';
const chart = process.env.CREWFORGE_SHOTS_CHART ?? '';
const namespace = process.env.CREWFORGE_SHOTS_NAMESPACE ?? '';
const crew = process.env.CREWFORGE_SHOTS_CREW ?? '';
/** The crew's display name, which titles its pages. */
const title = process.env.CREWFORGE_SHOTS_TITLE ?? crew;

const WIDTH = 1400;
const HEIGHT = 900;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` returns a value; the bound is a safety net, each check waits on a state. */
async function until<T>(what: string, check: () => T | undefined | Promise<T | undefined>, ms = 60_000, seen: () => unknown = () => undefined): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last seen: ${JSON.stringify(seen())}`);
    await sleep(200);
  }
}

/** A minimal Chrome DevTools Protocol client for VS Code's workbench window. */
class Devtools {
  private seq = 0;
  private readonly waiting = new Map<number, (value: unknown) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
      if (msg.id !== undefined) this.waiting.get(msg.id)?.(msg.result);
    });
  }

  static async connect(): Promise<Devtools> {
    const target = await until('the workbench window on the debugging port', async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.type === 'page' && t.url.includes('workbench.html'));
    });
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('Cannot reach VS Code on its debugging port')));
    });
    return new Devtools(socket);
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve) => {
      this.waiting.set(id, resolve as (value: unknown) => void);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates `expression` in the workbench page and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true });
    return reply.result.value;
  }

  /** The union of the boxes of the first element each selector finds. */
  async box(selectors: string[]): Promise<Rect> {
    const rect = await this.evaluate<Rect | null>(`(() => {
      const boxes = ${JSON.stringify(selectors)}.map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
      if (!boxes.length) return null;
      const x = Math.min(...boxes.map((b) => b.left)), y = Math.min(...boxes.map((b) => b.top));
      return { x, y, width: Math.max(...boxes.map((b) => b.right)) - x, height: Math.max(...boxes.map((b) => b.bottom)) - y };
    })()`);
    if (!rect) throw new Error(`Nothing on screen matches ${selectors.join(', ')}`);
    return rect;
  }

  /** The box of the element with this text inside `scope`. */
  async boxOfText(scope: string, text: string): Promise<Rect> {
    const rect = await this.evaluate<Rect | null>(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)});
      const found = [...(root ? root.querySelectorAll('*') : [])].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)});
      if (!found) return null;
      const b = found.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    })()`);
    if (!rect) throw new Error(`No "${text}" in ${scope}`);
    return rect;
  }

  async fixSize(height = HEIGHT, width = WIDTH): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, button: 'none' | 'left' | 'right' = 'none'): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0 });
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, button);
    await this.mouse('mouseReleased', x, y, button);
  }

  async escape(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }

  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async enter(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  }

  /** Saves `clip` of the window as `<name>.png`. */
  async shoot(name: string, clip: Rect, pad = 0): Promise<void> {
    const region = { x: Math.max(0, clip.x - pad), y: Math.max(0, clip.y - pad), width: Math.min(WIDTH, clip.width + 2 * pad), height: clip.height + 2 * pad, scale: 1 };
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: region });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`captured ${name}.png (${Math.round(region.width)} x ${Math.round(region.height)})`);
  }
}

const SIDEBAR = ['.part.activitybar', '.part.sidebar'];
const EDITOR = ['.part.editor'];
const MENU = '.monaco-menu-container';

async function crewforge(): Promise<CrewForgeApi> {
  const ext = vscode.extensions.getExtension<CrewForgeApi>('kubemoot.crewforge');
  if (!ext) throw new Error('CrewForge is not installed in this VS Code');
  return ext.activate();
}

async function pageOf(api: CrewForgeApi, title: string, words: string[]): Promise<string> {
  await until(`the ${title} page to show ${words.join(', ')}`, () => api.pages().find((p) => p.title === title && words.every((w) => p.shown?.includes(w)))?.key, 60_000, () => api.pages());
  return api.pages().find((p) => p.title === title)?.key ?? '';
}

/** Makes the side bar wider so tree lines read in full. */
async function widenSideBar(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.focusSideBar');
  for (let i = 0; i < 4; i++) await vscode.commands.executeCommand('workbench.action.increaseViewSize');
}

/** Rewrites the crew's description in its source, as an edit that is not deployed yet. */
export async function editSource(): Promise<vscode.TextDocument> {
  const file = vscode.Uri.file(path.join(chart, 'templates', 'crew.yaml'));
  const doc = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  const line = doc.getText().split('\n').findIndex((l) => l.includes('description:'));
  edit.replace(file, doc.lineAt(line).range, '  description: "Answers questions from the staff about accounts, devices, and the VPN."');
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  return doc;
}

/** Dismisses notifications, so no toast lands in a picture. */
async function clearNotifications(): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

async function showFile(file: string): Promise<void> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(chart, file)), { preview: false });
}

/** Opens a dashboard tab of the crew and waits for the words. */
async function openTab(api: CrewForgeApi, key: string, tab: string, words: string[]): Promise<void> {
  await api.press(key, 'tab', tab);
  await until(`the ${tab} tab to show ${words.join(', ')}`, () => api.pages().find((p) => p.key === key && words.every((w) => p.shown?.includes(w))));
  await sleep(1500);
}

/** Right-clicks `label` in the Explorer and captures the side bar with the menu it opens. */
async function contextMenu(dev: Devtools, name: string, label: string): Promise<void> {
  const at = await dev.boxOfText('.part.sidebar', label);
  await dev.click(at.x + at.width / 2, at.y + at.height / 2, 'right');
  await until('the context menu', () => dev.evaluate<boolean>(`document.querySelector('${MENU}') !== null`));
  await sleep(500);
  await dev.shoot(name, await dev.box([...SIDEBAR, MENU]));
  await dev.escape();
  await dev.mouse('mouseMoved', 900, 760);
  await sleep(300);
}

/** The two Explorer entries: New Kubemoot Crew Here outside a crew source, View in CrewForge inside one. */
async function explorerMenus(dev: Devtools): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(chart, 'templates', 'crew.yaml')));
  await sleep(1500);
  await contextMenu(dev, 'explorer-view-in-crewforge', 'crew.yaml');
  await contextMenu(dev, 'explorer-new-crew', 'notes');
}

/** The status bar: the connection on the right of the left group, and the crew of the open file beside it. */
async function statusBar(dev: Devtools): Promise<void> {
  await showFile('templates/crew.yaml');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.toggleActivityBarVisibility');
  await sleep(1000);
  await clearNotifications();
  await dev.mouse('mouseMoved', 900, 400);
  await sleep(1500);
  const bar = await dev.box(['.part.statusbar']);
  await dev.shoot('status-bar', { x: 0, y: bar.y - 190, width: 760, height: bar.height + 190 });
  await vscode.commands.executeCommand('workbench.action.toggleActivityBarVisibility');
}

/** A field the PromptModule schema does not define, found by Lint and listed in the Problems panel. */
async function lintProblems(dev: Devtools, source: unknown): Promise<void> {
  const file = vscode.Uri.file(path.join(chart, 'templates', 'promptmodules.yaml'));
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
  const last = doc.getText().lastIndexOf('  order: ');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(file, doc.positionAt(last), '  priority: high\n');
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  await vscode.commands.executeCommand('crewforge.lintCrew', source);
  await until('the lint finding', () => vscode.languages.getDiagnostics(file).find((d) => d.message.includes('priority')), 60_000, () => vscode.languages.getDiagnostics().map(([u, d]) => [u.fsPath, d.map((x) => x.message)]));
  const line = doc.getText().split('\n').findIndex((l) => l.includes('priority: high'));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await dev.mouse('mouseMoved', 900, 760);
  await sleep(1500);
  await dev.shoot('lint-problems', { x: 0, y: 32, width: WIDTH, height: HEIGHT - 32 });
  await vscode.commands.executeCommand('workbench.action.closePanel');
}

/** A context nobody answers on: the trees and the status bar say so in plain words. */
async function unreachable(api: CrewForgeApi, dev: Devtools): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.kubemoot');
  await vscode.workspace.getConfiguration('crewforge').update('context', 'kind-staging', vscode.ConfigurationTarget.Global);
  await until(
    'the tree to name the unreachable context',
    async () => (await api.crews.getChildren()).some((n) => String(api.crews.getTreeItem(n).label).startsWith('No response from context kind-staging')),
    60_000,
    () => api.crews.known,
  );
  await clearNotifications();
  await sleep(1500);
  await dev.shoot('unreachable', await dev.box(SIDEBAR));
}

export async function run(): Promise<void> {
  const api = await crewforge();
  const dev = await Devtools.connect();
  await dev.fixSize();
  await sleep(1000);

  await vscode.commands.executeCommand('workbench.view.extension.kubemoot');
  const live = await until('the live crew', () => api.crews.nodeFor(namespace, crew));
  const source = await until('the crew source', async () => (await api.sources.getChildren()).find((n) => n.kind === 'source' && n.entry.source.root.endsWith(crew)));
  await showFile('templates/crew.yaml');
  await widenSideBar();
  await api.crewsView.reveal(live, { expand: true, select: false, focus: false });
  await api.crewsView.reveal(await api.crews.sectionNode(live.crew, 'models'), { expand: true, select: false, focus: false });
  await api.sourcesView.reveal(source, { expand: true, select: false, focus: false });
  await clearNotifications();
  await sleep(2500);
  await dev.shoot('views', await dev.box(SIDEBAR));

  await vscode.commands.executeCommand('workbench.actions.treeView.crewforge.crews.collapseAll');
  await vscode.commands.executeCommand('workbench.actions.treeView.crewforge.sources.collapseAll');
  await api.crewsView.reveal(await api.crews.sectionNode(live.crew, 'fitness'), { expand: true, select: true, focus: true });
  await clearNotifications();
  await dev.mouse('mouseMoved', 900, 600);
  await sleep(2000);
  await dev.shoot('live-fitness', await dev.box(SIDEBAR));

  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('crewforge.openCrewDashboard', source);
  const key = await pageOf(api, title, ['Overview']);
  await dev.fixSize(1140, 1000);
  await clearNotifications();
  await sleep(2500);
  await dev.shoot('crew-overview', await dev.box(EDITOR));
  await dev.fixSize();

  await vscode.commands.executeCommand('crewforge.openFitnessDashboard', live);
  const fitnessKey = await pageOf(api, `${title} fitness`, ['Pause', 'honest-no-fabrication']);
  await clearNotifications();
  await sleep(2500);
  await dev.fixSize(780, 1000);
  await dev.shoot('fitness-dashboard', await dev.box(EDITOR));
  await dev.fixSize();
  void fitnessKey;

  await vscode.commands.executeCommand('crewforge.askCrew', live);
  await until('the chat to open', () => api.chats().find((c) => c.ready && c.shown?.includes(crew)));
  await sleep(1000);
  const pane = await dev.box(EDITOR);
  await dev.click(pane.x + pane.width / 2, pane.y + pane.height - 50);
  await dev.type('A user cannot connect to the VPN from home. What should I check first?');
  await dev.enter();
  await until('the agents to report', () => api.chats().find((c) => c.shown?.includes('agrees')), 60_000, () => api.chats());
  await dev.shoot('chat-running', { ...pane, height: 460 });
  await until('the answer', () => api.chats().find((c) => c.shown?.includes('Start with what the VPN client reports')), 60_000, () => api.chats());
  await sleep(1500);
  await dev.click(pane.x + 330, pane.y + 339);
  await sleep(500);
  await dev.mouse('mouseMoved', pane.x + 700, pane.y + 215);
  await sleep(800);
  await dev.shoot('chat-answer', { ...pane, height: 560 });

  await editSource();
  await vscode.commands.executeCommand('crewforge.openCrewDashboard', source);
  await openTab(api, key, 'diff', ['description']);
  await clearNotifications();
  await dev.fixSize(780, 1000);
  await dev.shoot('crew-diff', await dev.box(EDITOR));
  await dev.fixSize();

  await explorerMenus(dev);
  await statusBar(dev);
  await lintProblems(dev, source);
  await unreachable(api, dev);
}
