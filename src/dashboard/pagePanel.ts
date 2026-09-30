import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PageHostMessage, PageMessage } from '../webview/pageProtocol';
import { errorText } from '../views/errors';
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

/**
 * A dashboard page in an editor tab: one per key. It renders its model when it opens,
 * again after each button, whenever it becomes visible, and on the model's schedule
 * while visible. The page is untrusted: it can only name an action of the model, with
 * a text argument, and the extension decides what that does.
 */
export class PagePanel {
  private static readonly panels = new Map<string, PagePanel>();

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

  private readonly panel: vscode.WebviewPanel;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly key: string,
    readonly model: PageModel,
  ) {
    this.panel = vscode.window.createWebviewPanel('crewforge.page', model.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'logo.svg');
    this.panel.webview.html = shell(this.panel.webview, extensionUri, model.title());
    this.panel.webview.onDidReceiveMessage((m: PageMessage) => this.onMessage(m));
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible) void this.refresh();
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  /** Renders the model into the page, and schedules the next read while the page is visible. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let html: string;
    try {
      html = await this.model.render();
    } catch (err) {
      html = `<p class="error">${escape(`CrewForge could not read this page: ${errorText(err)}`)}</p>`;
    }
    if (this.disposed) return;
    this.panel.title = this.model.title();
    const message: PageHostMessage = { type: 'render', html };
    await this.panel.webview.postMessage(message);
    this.schedule();
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
    if (m?.type === 'ready') return this.refresh();
    if (m?.type !== 'action' || typeof m.action !== 'string' || !Object.hasOwn(this.model.actions, m.action)) return;
    const arg = typeof m.arg === 'string' ? m.arg : undefined;
    try {
      await this.model.actions[m.action](arg);
    } catch (err) {
      void vscode.window.showErrorMessage(`CrewForge: ${errorText(err)}`);
    }
    await this.refresh();
  }

  private dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    PagePanel.panels.delete(this.key);
  }
}

/** The page around the body: a strict content security policy, the page stylesheet, and the page script by nonce. */
function shell(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'page.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'page.css'));
  const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `img-src ${webview.cspSource} data:`, `script-src 'nonce-${nonce}'`].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${escape(title)}</title>
</head>
<body>
<main id="root"><p class="muted">Reading...</p></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
