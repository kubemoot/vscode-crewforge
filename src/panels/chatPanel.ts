import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { dashboardUrl, streamTimeoutMs, type Connection } from '../connection';
import { unreachable, type CrewAvailability } from '../discussion/availability';
import { DEFAULT_TIMING } from '../discussion/client';
import { ChatSession, type SessionView } from '../discussion/session';
import type { CrewSummary } from '../k8s/crews';
import { newConversation, questionFor, type Conversation, type ConversationMeta } from '../store/conversation';
import type { ConversationStore } from '../store/conversations';
import { exportAsMarkdown, exportFileName } from '../store/export';
import { crewAbout } from '../views/treeModel';
import type { HostMessage, WebviewMessage } from '../webview/protocol';
import { icons } from '../webview/render';
import type { Located } from '../source/locate';
import { trimEnd } from '../text';

/** What a chat can link to in the workspace. */
export interface ChatLinks {
  /**
   * Where each of the crew's agents is defined: its Agent, then the PromptModules it
   * composes. Empty when no workspace source renders the crew.
   */
  agentSources(crew: CrewSummary): Promise<Map<string, Located[]>>;
  /** Whether the crew can take a question now, read from the cluster; the page blocks sending when it cannot. */
  availability?(crew: CrewSummary): Promise<CrewAvailability>;
}

/** How often an open, visible chat reads its crew's availability again. */
export const AVAILABILITY_MS = 15_000;

/** A chat with one crew. One panel per context, namespace and crew. */
export class ChatPanel {
  private static readonly panels = new Map<string, ChatPanel>();
  private static activePanel?: ChatPanel;

  private readonly session: ChatSession;

  static show(extensionUri: vscode.Uri, connection: Connection, crew: CrewSummary, store: ConversationStore, conversation?: Conversation, links?: ChatLinks): ChatPanel {
    const existing = ChatPanel.find(connection.context, crew);
    if (existing) {
      existing.panel.reveal();
      if (conversation) existing.session.load(conversation);
      return existing;
    }
    const key = panelKey(connection.context, crew);
    const panel = new ChatPanel(extensionUri, connection, crew, store, conversation, key, links);
    ChatPanel.panels.set(key, panel);
    return panel;
  }

  /** The open chat with a crew in a context, if there is one. */
  static find(context: string, crew: Pick<CrewSummary, 'namespace' | 'name'>): ChatPanel | undefined {
    return ChatPanel.panels.get(panelKey(context, crew));
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
    links?: ChatLinks,
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
      if (this.panel.visible) void this.readAvailability?.();
    });
    this.panel.onDidDispose(() => this.dispose());
    ChatPanel.activePanel = this;
    if (links) void this.loadSources(links);
    if (links?.availability) this.followAvailability(links.availability.bind(links));
  }

  /**
   * Reads the crew's availability now, then again while the panel is visible, when it
   * becomes visible, and after each turn. A read already under way is not started again.
   */
  private followAvailability(read: (crew: CrewSummary) => Promise<CrewAvailability>): void {
    let reading = false;
    this.readAvailability = async () => {
      if (reading) return;
      reading = true;
      try {
        this.availability = await read(this.crew);
      } catch (err) {
        this.availability = unreachable(err);
      } finally {
        reading = false;
      }
      await this.post(this.session.view);
    };
    void this.readAvailability();
    this.availabilityTimer = setInterval(() => {
      if (this.panel.visible) void this.readAvailability?.();
    }, AVAILABILITY_MS);
  }

  /** Where each agent is defined, read once when the panel opens; the page links the agents found. */
  private async loadSources(links: ChatLinks): Promise<void> {
    try {
      this.agentSources = await links.agentSources(this.crew);
    } catch {
      this.agentSources = new Map();
    }
    await this.post(this.session.view);
  }

  /**
   * Asks the conversation's last question again, as a new turn, after a redeploy.
   * Reports false when there is none to ask, or a turn is running.
   */
  async reaskLast(): Promise<boolean> {
    const messages = this.session.view.conversation.messages;
    const question = questionFor(messages, messages.length - 1);
    if (!question || this.session.busy) return false;
    this.panel.reveal();
    await this.session.send(question);
    return true;
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

  private handle(m: WebviewMessage): Promise<unknown> {
    // The page is not trusted: a message of a type this panel does not know is ignored.
    const handler = this.handlers[m.type] as ((message: WebviewMessage) => unknown) | undefined;
    return Promise.resolve(handler?.(m));
  }

  /** What each message from the page does, by type. */
  private readonly handlers: { [K in WebviewMessage['type']]: (m: Extract<WebviewMessage, { type: K }>) => unknown } = {
    ready: () => this.onReady(),
    send: (m) => this.session.send(m.text),
    stop: () => this.session.stop(),
    new: () => this.session.load(newConversation(this.connection.context, this.crew.namespace, this.crew.name)),
    open: (m) => this.open(m.id),
    copy: () => vscode.env.clipboard.writeText(exportAsMarkdown(this.session.view.conversation)),
    copyMessage: (m) => this.copyMessage(m.index),
    reask: (m) => this.reask(m.index),
    export: () => this.export(),
    rename: () => this.rename(),
    delete: () => this.deleteConversation(),
    openDashboard: () => openDashboard(),
    openAgentSource: (m) => this.openAgentSource(m.agent),
    openTurnInDashboard: (m) => this.openTurnInDashboard(m.index),
  };

  /** Opens the file where an agent is defined, or one of its PromptModules the developer picks. */
  private async openAgentSource(agent: unknown): Promise<void> {
    const places = typeof agent === 'string' ? this.agentSources.get(agent) : undefined;
    if (!places?.length) return;
    const choice = places.length === 1 ? places[0] : await pickPlace(String(agent), places);
    if (choice?.file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(choice.file), { selection: new vscode.Range(choice.line, 0, choice.line, 0) });
  }

  /** Opens the dashboard at the thread of the turn message `index` ends. */
  private async openTurnInDashboard(index: unknown): Promise<void> {
    const message = typeof index === 'number' ? this.session.view.conversation.messages[index] : undefined;
    const url = dashboardUrl();
    if (!url || typeof message?.threadId !== 'string') return;
    await vscode.env.openExternal(vscode.Uri.parse(dashboardThreadUrl(url, this.crew, message.threadId)));
  }

  /**
   * Puts text in the chat input for the person to finish and send. A page still loading
   * gets it once it says it is ready.
   */
  prefill(text: string): void {
    this.pendingPrefill = text;
    if (this.pageReady) void this.sendPrefill();
  }

  private async onReady(): Promise<void> {
    await this.post(this.session.view);
    this.pageReady = true;
    await this.sendPrefill();
  }

  private async sendPrefill(): Promise<void> {
    const text = this.pendingPrefill;
    if (text === undefined || this.disposed) return;
    this.pendingPrefill = undefined;
    const message: HostMessage = { type: 'prefill', text };
    await this.panel.webview.postMessage(message);
  }

  private async open(id: string): Promise<void> {
    const c = await this.store.load({ context: this.connection.context, namespace: this.crew.namespace, crewName: this.crew.name, id });
    this.session.load(c);
  }

  private async copyMessage(index: number): Promise<void> {
    const message = this.session.view.conversation.messages[index];
    if (message) await vscode.env.clipboard.writeText(message.content);
  }

  private async reask(index: number): Promise<void> {
    const question = questionFor(this.session.view.conversation.messages, index);
    if (question) await this.session.send(question);
  }

  /** Asks for a new name for the conversation; its first question stays the name until then. */
  private async rename(): Promise<void> {
    const title = await vscode.window.showInputBox({
      title: 'Rename conversation',
      value: this.session.view.conversation.title,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
    });
    if (title) await this.session.rename(title);
  }

  /**
   * Deletes the conversation from this computer after asking, and closes the panel. Not
   * while a turn runs: stopping it saves the conversation again. A failed delete leaves
   * the panel open and is reported like any other failed action.
   */
  private async deleteConversation(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Delete this conversation?',
      { modal: true, detail: `"${this.session.view.conversation.title}" is removed from this computer. The crew is not changed.` },
      DELETE,
    );
    if (choice !== DELETE) return;
    if (await this.session.remove((c) => this.store.remove(c))) this.panel.dispose();
    else void vscode.window.showInformationMessage('Stop the turn before deleting the conversation.');
  }

  private history: ConversationMeta[] = [];
  /** The crew's availability, once read; undefined when there is no way to read it. */
  private availability?: CrewAvailability;
  private readAvailability?: () => Promise<void>;
  private availabilityTimer?: ReturnType<typeof setInterval>;
  /** Whether the last posted view had a turn running, to read the availability again when it ends. */
  private wasBusy = false;
  /** Where each agent is defined, once read; empty until then or when no source is open. */
  private agentSources = new Map<string, Located[]>();
  /** The page has said it is ready for messages. */
  private pageReady = false;
  /** Text for the input, waiting for the page to be ready. */
  private pendingPrefill?: string;
  private disposed = false;

  /** Posts the session's current view; the history list is re-read only between turns. */
  private async post(view: SessionView): Promise<void> {
    if (this.disposed) return;
    const turnEnded = this.wasBusy && !view.busy;
    this.wasBusy = view.busy;
    if (turnEnded) void this.readAvailability?.();
    if (!view.busy) this.history = await this.store.list(this.connection.context, this.crew.namespace, this.crew.name);
    if (this.disposed) return;
    const links = { agents: [...this.agentSources.keys()], dashboard: dashboardUrl() !== '' };
    const message: HostMessage = { type: 'state', view: this.session.view, history: this.history, about: crewAbout(this.crew), links, availability: this.availability };
    await this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    this.disposed = true;
    if (this.availabilityTimer) clearInterval(this.availabilityTimer);
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
    <footer class="sidebar-footer"><p class="powered-by" title="AI can make mistakes. Verify important info.">Powered by <a href="#" id="dashboard">Kubemoot</a></p></footer>
  </aside>
  <div class="sidebar-resizer" id="resizer" title="Drag to resize"></div>
  <div class="chat-container">
    <header class="chat-header">
      <div class="header-left">
        <button class="toggle-sidebar-btn" id="toggle" title="Show or hide conversations">&#9776;</button>
        <h1 id="title"></h1><span class="crew-where" id="where"></span>
      </div>
      <div class="header-actions">
        <button class="export-btn" id="rename" title="Rename conversation" aria-label="Rename conversation" hidden>${icons.edit}</button>
        <button class="export-btn" id="delete" title="Delete conversation" aria-label="Delete conversation" hidden>${icons.trash}</button>
        <button class="export-btn" id="copy" title="Copy conversation as Markdown" aria-label="Copy conversation as Markdown" hidden>${icons.copy}</button>
        <button class="export-btn" id="export" title="Save conversation as Markdown" aria-label="Save conversation as Markdown" hidden>${icons.download}</button>
      </div>
    </header>
    <div class="messages" id="messages"></div>
    <p class="input-note" id="note" role="status" hidden></p>
    <form class="input-area" id="form">
      <textarea id="input" rows="1" placeholder="Ask the crew a question..."></textarea>
      <button type="submit" class="send-btn" id="send" title="Send" hidden></button>
    </form>
  </div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

const DELETE = 'Delete';

/** Asks which of an agent's definitions to open: the Agent, then its PromptModules in composition order. */
async function pickPlace(agent: string, places: Located[]): Promise<Located | undefined> {
  const choice = await vscode.window.showQuickPick(
    places.map((l) => ({ label: `${l.manifest.kind} ${l.manifest.metadata.name}`, description: l.file ? `${vscode.workspace.asRelativePath(l.file)}:${l.line + 1}` : undefined, place: l })),
    { placeHolder: `Open which part of ${agent}? Its PromptModules follow in the order it composes them.` },
  );
  return choice?.place;
}

function panelKey(context: string, crew: Pick<CrewSummary, 'namespace' | 'name'>): string {
  return `${context}/${crew.namespace}/${crew.name}`;
}

/**
 * The dashboard's Discussions page for one thread: the base URL from the setting, then
 * `/discussions` with the thread, namespace, and crew as query parameters.
 */
export function dashboardThreadUrl(base: string, crew: Pick<CrewSummary, 'namespace' | 'name'>, threadId: string): string {
  const query = new URLSearchParams({ thread: threadId, namespace: crew.namespace, crew: crew.name });
  return `${trimEnd(base, '/')}/discussions?${query.toString()}`;
}

/** Opens the Kubemoot dashboard in the default browser, or the setting that names it when unset. */
async function openDashboard(): Promise<void> {
  const url = dashboardUrl();
  if (url) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  await vscode.commands.executeCommand('workbench.action.openSettings', 'crewforge.dashboardUrl');
}
