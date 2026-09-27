import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { streamTimeoutMs, type Connection } from '../connection';
import { DEFAULT_TIMING } from '../discussion/client';
import { ChatSession, type SessionView } from '../discussion/session';
import type { CrewSummary } from '../k8s/crews';
import { newConversation, type Conversation, type ConversationMeta } from '../store/conversation';
import type { ConversationStore } from '../store/conversations';
import { exportAsMarkdown, exportFileName } from '../store/export';
import { crewAbout } from '../views/treeModel';
import type { HostMessage, WebviewMessage } from '../webview/protocol';

/** A chat with one crew. One panel per context, namespace and crew. */
export class ChatPanel {
  private static readonly panels = new Map<string, ChatPanel>();
  private static activePanel?: ChatPanel;

  private readonly session: ChatSession;

  static show(extensionUri: vscode.Uri, connection: Connection, crew: CrewSummary, store: ConversationStore, conversation?: Conversation): ChatPanel {
    const key = `${connection.context}/${crew.namespace}/${crew.name}`;
    const existing = ChatPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (conversation) existing.session.load(conversation);
      return existing;
    }
    const panel = new ChatPanel(extensionUri, connection, crew, store, conversation, key);
    ChatPanel.panels.set(key, panel);
    return panel;
  }

  static get active(): ChatPanel | undefined {
    return ChatPanel.activePanel;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: Connection,
    private readonly crew: CrewSummary,
    private readonly store: ConversationStore,
    conversation: Conversation | undefined,
    private readonly key: string,
  ) {
    this.panel = vscode.window.createWebviewPanel('crewforge.chat', `Ask ${crew.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'logo.svg');
    const timing = { ...DEFAULT_TIMING, maxMs: streamTimeoutMs() };
    this.session = new ChatSession(
      connection.client,
      conversation ?? newConversation(connection.context, crew.namespace, crew.name),
      (c) => store.save(c),
      (view) => void this.post(view),
      timing,
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m));
    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) ChatPanel.activePanel = this;
    });
    this.panel.onDidDispose(() => this.dispose());
    ChatPanel.activePanel = this;
  }

  /** Saves the shown conversation as Markdown where the person chooses. */
  async export(): Promise<void> {
    const c = this.session.view.conversation;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(exportFileName(c)),
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    await fs.writeFile(target.fsPath, exportAsMarkdown(c), 'utf8');
    void vscode.window.showInformationMessage(`Saved ${target.fsPath}`);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    try {
      await this.handle(m);
    } catch (err) {
      void vscode.window.showErrorMessage(`CrewForge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handle(m: WebviewMessage): Promise<unknown> {
    switch (m.type) {
      case 'ready':
        return this.post(this.session.view);
      case 'send':
        return this.session.send(m.text);
      case 'stop':
        return this.session.stop();
      case 'new':
        return this.session.load(newConversation(this.connection.context, this.crew.namespace, this.crew.name));
      case 'open':
        return this.open(m.id);
      case 'copy':
        return vscode.env.clipboard.writeText(exportAsMarkdown(this.session.view.conversation));
      case 'copyMessage':
        return this.copyMessage(m.index);
      case 'export':
        return this.export();
    }
  }

  private async open(id: string): Promise<void> {
    const c = await this.store.load({ context: this.connection.context, namespace: this.crew.namespace, crewName: this.crew.name, id });
    this.session.load(c);
  }

  private async copyMessage(index: number): Promise<void> {
    const message = this.session.view.conversation.messages[index];
    if (message) await vscode.env.clipboard.writeText(message.content);
  }

  private history: ConversationMeta[] = [];
  private disposed = false;

  /** Posts the session's current view; the history list is re-read only between turns. */
  private async post(view: SessionView): Promise<void> {
    if (this.disposed) return;
    if (!view.busy) this.history = await this.store.list(this.connection.context, this.crew.namespace, this.crew.name);
    if (this.disposed) return;
    const message: HostMessage = { type: 'state', view: this.session.view, history: this.history, about: crewAbout(this.crew) };
    await this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    this.disposed = true;
    this.session.stop();
    ChatPanel.panels.delete(this.key);
    if (ChatPanel.activePanel === this) ChatPanel.activePanel = undefined;
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `img-src ${webview.cspSource} data:`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Ask ${this.crew.name}</title>
</head>
<body>
<div class="chat-layout">
  <aside class="discussion-sidebar" id="sidebar">
    <div class="sidebar-header"><h2>Conversations</h2><button class="new-chat-btn" id="new" title="New conversation">+</button></div>
    <div class="discussion-list" id="history"></div>
    <footer class="sidebar-footer"><p class="powered-by">Powered by Kubemoot</p><p class="disclaimer">AI can make mistakes. Verify important info.</p></footer>
  </aside>
  <div class="sidebar-resizer" id="resizer" title="Drag to resize"></div>
  <div class="chat-container">
    <header class="chat-header">
      <div class="header-left">
        <button class="toggle-sidebar-btn" id="toggle" title="Show or hide conversations">&#9776;</button>
        <h1 id="title"></h1><span class="crew-where" id="where"></span>
      </div>
      <div class="header-actions">
        <button class="export-btn" id="copy" title="Copy conversation as Markdown" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
        <button class="export-btn" id="export" title="Save conversation as Markdown" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
    </header>
    <div class="messages" id="messages"></div>
    <form class="input-area" id="form">
      <textarea id="input" rows="1" placeholder="Ask the crew a question..."></textarea>
      <button type="submit" class="send-btn" id="send" title="Send"></button>
    </form>
  </div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
