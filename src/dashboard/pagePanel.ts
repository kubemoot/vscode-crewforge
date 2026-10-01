import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PageHostMessage, PageMessage } from '../webview/pageProtocol';
import { messageText, type PanelState } from '../panels/panelState';
import { tabIcon } from '../panels/tabIcon';
import { errorText } from '../views/errors';
import { showError } from '../views/notify';
import { escape } from './html';

/** What a dashboard page shows and what its buttons do. */
export interface PageModel {
  /** The tab's title. */
  title(): string;
  /** The page body as HTML, every value in it escaped. */
  render(): Promise<string>;
  /** Each button's action by name; the page may name only these. */
  actions: Record<string, (arg?: string) => Promise<unknown>>;
  /** How long until the page reads again while visible, or undefined to wait for a button or Refresh. */
  refreshMs(): number | undefined;
}

/** Where an open page stands, by its key. */
export interface PageState extends PanelState {
  key: string;
}

/** What every page shares: where problems are logged, and what the pages read from, as the person knows it (a context name). */
export interface PageHost {
  log: (line: string) => void;
  readingFrom: () => string;
}

/**
 * How long a page waits before it says it is still reading, and before it gives up on a
 * read and shows why. Both are safety nets for a slow or unreachable cluster; each read
 * normally finishes well inside them.
 */
export const PAGE_WAIT = { stillReadingMs: 2_000, readLimitMs: 45_000, scriptStartMs: 15_000 };

/**
 * A dashboard page in an editor tab: one per key. It renders its model when it opens,
 * again after each button, whenever it becomes visible, and on the model's schedule
 * while visible. The page is untrusted: it can only name an action of the model, with
 * a text argument, and the extension decides what that does.
 */
export class PagePanel {
  private static readonly panels = new Map<string, PagePanel>();
  /** Where page problems are logged, and what pages read from; set once when CrewForge starts. */
  static host: PageHost = { log: () => undefined, readingFrom: () => 'the cluster' };

  /** Opens the page for `key`, or shows and refreshes the one already open. */
  static show(extensionUri: vscode.Uri, key: string, model: PageModel): PagePanel {
    const existing = PagePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.refresh();
      return existing;
    }
    const page = new PagePanel(extensionUri, key, model);
    PagePanel.panels.set(key, page);
    return page;
  }

  /** The open page for `key`, if there is one. */
  static find(key: string): PagePanel | undefined {
    return PagePanel.panels.get(key);
  }

  /** Every open page and what it shows. */
  static states(): PageState[] {
    return [...PagePanel.panels.values()].map((p) => ({ ...p.state, title: p.panel.title, errors: [...p.state.errors] }));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly state: PageState;
  private timer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private reading?: Promise<void>;
  private again = false;
  private disposed = false;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly key: string,
    readonly model: PageModel,
  ) {
    this.state = { key, title: model.title(), ready: false, errors: [] };
    this.panel = vscode.window.createWebviewPanel('crewforge.page', model.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = tabIcon(extensionUri);
    this.panel.webview.html = shell(this.panel.webview, extensionUri, model.title());
    this.panel.webview.onDidReceiveMessage((m: PageMessage) => this.onMessage(m));
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible) void this.refresh();
    });
    this.panel.onDidDispose(() => this.dispose());
    this.startTimer = setTimeout(() => PagePanel.host.log(`The page script of "${model.title()}" did not start within ${PAGE_WAIT.scriptStartMs / 1000} s.`), PAGE_WAIT.scriptStartMs);
  }

  /** Renders the model into the page, and schedules the next read while the page is visible. A read under way is followed by one more. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = this.read().finally(() => {
      this.reading = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const still = setTimeout(() => void this.post({ type: 'status', text: `Still reading from ${this.from()}...` }), PAGE_WAIT.stillReadingMs);
    const html = await this.boundedRender();
    clearTimeout(still);
    if (this.disposed) return;
    this.panel.title = this.model.title();
    await this.post({ type: 'status', text: '' });
    await this.post({ type: 'render', html });
    this.schedule();
  }

  /**
   * The model's render, or an error saying why there is none: it failed, or took longer
   * than the read limit. A render that outlives the limit is left to finish and ignored;
   * the next read starts a fresh one.
   */
  private async boundedRender(): Promise<string> {
    let limit: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      const seconds = PAGE_WAIT.readLimitMs / 1000;
      limit = setTimeout(() => resolve(errorHtml(`No answer from ${this.from()} in ${seconds} s. Is the cluster running? Refresh reads again.`)), PAGE_WAIT.readLimitMs);
    });
    try {
      return await Promise.race([this.model.render(), late]);
    } catch (err) {
      return errorHtml(`CrewForge could not read this page: ${errorText(err)}`);
    } finally {
      clearTimeout(limit);
    }
  }

  private from(): string {
    try {
      return PagePanel.host.readingFrom() || 'the cluster';
    } catch {
      return 'the cluster';
    }
  }

  private async post(message: PageHostMessage): Promise<void> {
    if (!this.disposed) await this.panel.webview.postMessage(message);
  }

  private schedule(): void {
    const ms = this.model.refreshMs();
    if (ms === undefined || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.panel.visible) void this.refresh();
    }, ms);
  }

  private async onMessage(m: PageMessage): Promise<void> {
    switch (m?.type) {
      case 'ready':
        return this.started();
      case 'shown':
        this.state.shown = messageText(m.text);
        return;
      case 'error':
        return this.scriptError(m.message);
      case 'action':
        return this.act(m);
    }
  }

  private started(): Promise<void> {
    this.state.ready = true;
    clearTimeout(this.startTimer);
    return this.refresh();
  }

  private scriptError(message: unknown): void {
    const text = messageText(message);
    this.state.errors.push(text);
    PagePanel.host.log(`The page "${this.panel.title}" reported: ${text}`);
  }

  private async act(m: Extract<PageMessage, { type: 'action' }>): Promise<void> {
    if (typeof m.action !== 'string' || !Object.hasOwn(this.model.actions, m.action)) return;
    const arg = typeof m.arg === 'string' ? m.arg : undefined;
    try {
      await this.model.actions[m.action](arg);
    } catch (err) {
      void showError(err);
    }
    await this.refresh();
  }

  private dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    PagePanel.panels.delete(this.key);
  }
}

function errorHtml(text: string): string {
  return `<p class="error">${escape(text)}</p>`;
}

/**
 * The page around the body: a strict content security policy, the page stylesheet, and the
 * page script by nonce. Until the script starts, the page says it is reading; if the script
 * never starts (it did not load), a notice appears after a while, styled inline so it shows
 * even when the stylesheet did not load either. The script removes the notice as it starts.
 */
function shell(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'page.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'page.css'));
  const csp = [`default-src 'none'`, `style-src ${webview.cspSource} 'nonce-${nonce}'`, `img-src ${webview.cspSource} data:`, `script-src 'nonce-${nonce}'`].join('; ');
  const wait = PAGE_WAIT.scriptStartMs / 1000;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<style nonce="${nonce}">#stuck{visibility:hidden;animation:crewforge-stuck 0s ${wait}s forwards}@keyframes crewforge-stuck{to{visibility:visible}}</style>
<title>${escape(title)}</title>
</head>
<body>
<p id="status" class="muted" hidden></p>
<main id="root"><p class="muted">Reading...</p><p id="stuck" class="error">This page did not start: its script (dist/page.js) did not load, so CrewForge cannot show it. Run Developer: Reload Window; if the page stays empty, reinstall CrewForge and report it with CrewForge: Show Connection Info.</p></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
