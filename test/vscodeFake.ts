/**
 * A small stand-in for the `vscode` module: the parts of the API CrewForge uses,
 * recording what the extension does and letting a test drive it. Aliased to `vscode`
 * in vitest.config.mjs.
 */
type Listener<T> = (value: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const ProgressLocation = { Notification: 15 } as const;

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const ViewColumn = { Active: -1, Beside: -2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export class Diagnostic {
  source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: number,
  ) {}
}

/** A diagnostic collection that keeps what was set, by URI text. */
export class FakeDiagnostics {
  entries = new Map<string, Diagnostic[]>();
  constructor(public name: string) {}
  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
  dispose(): void {
    this.entries.clear();
  }
}

export class FakeStatusBarItem {
  text = '';
  tooltip?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  visible = false;
  constructor(
    public alignment: number,
    public priority: number,
  ) {}
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.visible = false;
  }
}
export const ConfigurationTarget = { Global: 1 } as const;

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: number,
  ) {}
}

export class Range {
  constructor(
    public startLine: number,
    public startCharacter: number,
    public endLine: number,
    public endCharacter: number,
  ) {}
}

export class CodeLens {
  constructor(
    public range: Range,
    public command?: { title: string; command: string; arguments?: unknown[] },
  ) {}
}

export const languages = {
  createDiagnosticCollection(name: string) {
    const collection = new FakeDiagnostics(name);
    recorded.diagnostics.push(collection);
    return collection;
  },
  registerCodeLensProvider(_selector: unknown, provider: unknown) {
    recorded.codeLensProviders.push(provider);
    return { dispose: () => undefined };
  },
  setTextDocumentLanguage<T extends { languageId?: string }>(document: T, languageId: string) {
    document.languageId = languageId;
    return Promise.resolve(document);
  },
};

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class Uri {
  private constructor(
    public fsPath: string,
    private text: string,
    public scheme = 'file',
  ) {}
  static file(p: string): Uri {
    return new Uri(p, `file://${p}`);
  }
  static parse(s: string): Uri {
    return new Uri(s, s, /^([a-z][\w+.-]*):/i.exec(s)?.[1] ?? 'file');
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    const p = [base.fsPath, ...parts].join('/');
    return new Uri(p, `file://${p}`);
  }
  toString(): string {
    return this.text;
  }
}

/** Everything the fake recorded, and the answers queued for dialogs. */
export const recorded = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as { id: string; args: unknown[] }[],
  info: [] as string[],
  errors: [] as string[],
  /** Error messages shown as modal dialogs (also in errors). */
  modalErrors: [] as string[],
  clipboard: [] as string[],
  opened: [] as string[],
  panels: [] as FakePanel[],
  treeViews: [] as FakeTreeView[],
  settings: new Map<string, unknown>(),
  quickPicks: [] as unknown[],
  saveDialog: undefined as Uri | undefined,
  openDialog: undefined as Uri[] | undefined,
  configListeners: [] as Listener<{ affectsConfiguration: (s: string) => boolean }>[],
  /** Workspace files findFiles answers with, by glob. */
  files: new Map<string, string[]>(),
  inputs: [] as (string | undefined)[],
  warnings: [] as string[],
  warningAnswers: [] as (string | undefined)[],
  output: [] as string[],
  workspaceFolders: undefined as { name: string; uri: Uri }[] | undefined,
  shownDocuments: [] as string[],
  progress: [] as string[],
  extensions: new Map<string, unknown>(),
  codeLensProviders: [] as unknown[],
  textDocuments: [] as { uri: Uri; getText(): string; isDirty?: boolean }[],
  /** The answer applyEdit gives; false makes it fail. */
  applyEditResult: true,
  cancel: undefined as (() => void) | undefined,
  documentProviders: new Map<string, { provideTextDocumentContent(uri: Uri): string }>(),
  /** Answers for information messages with actions, in order; undefined dismisses. */
  infoAnswers: [] as (string | undefined)[],
  /** Options each showTextDocument call got, in order. */
  shownOptions: [] as unknown[],
  diagnostics: [] as FakeDiagnostics[],
  statusBarItems: [] as FakeStatusBarItem[],
  editorListeners: [] as Listener<unknown>[],
  saveListeners: [] as Listener<{ uri: Uri }>[],
  /** Nodes revealed in tree views, with the view's id. */
  revealed: [] as { view: string; node: unknown; options?: unknown }[],
  /** Values stored in the fake workspace state. */
  workspaceState: new Map<string, unknown>(),
  /** File system watchers created, by glob. */
  watchers: [] as FakeWatcher[],
  folderListeners: [] as Listener<unknown>[],
  /** Paths moved to the trash (or deleted) through workspace.fs. */
  trashed: [] as string[],
  /** The editor window.activeTextEditor answers with. */
  activeEditor: undefined as { document: { uri: Uri; languageId: string; getText(range?: unknown): string }; selection: unknown } | undefined,
};

export function resetFake(): void {
  recorded.commands.clear();
  recorded.executed = [];
  recorded.info = [];
  recorded.errors = [];
  recorded.modalErrors = [];
  recorded.clipboard = [];
  recorded.opened = [];
  recorded.panels = [];
  recorded.treeViews = [];
  recorded.settings.clear();
  recorded.quickPicks = [];
  recorded.saveDialog = undefined;
  recorded.openDialog = undefined;
  recorded.configListeners = [];
  recorded.files.clear();
  recorded.documentProviders.clear();
  recorded.inputs = [];
  recorded.warnings = [];
  recorded.warningAnswers = [];
  recorded.output = [];
  recorded.workspaceFolders = undefined;
  recorded.shownDocuments = [];
  recorded.progress = [];
  recorded.extensions.clear();
  recorded.codeLensProviders = [];
  recorded.textDocuments = [];
  recorded.applyEditResult = true;
  recorded.cancel = undefined;
  recorded.activeEditor = undefined;
  recorded.infoAnswers = [];
  recorded.shownOptions = [];
  recorded.diagnostics = [];
  recorded.statusBarItems = [];
  recorded.editorListeners = [];
  recorded.saveListeners = [];
  recorded.revealed = [];
  recorded.workspaceState.clear();
  recorded.watchers = [];
  recorded.folderListeners = [];
  recorded.trashed = [];
}

/** A workspace edit that records file renames. */
export class WorkspaceEdit {
  renames: [Uri, Uri][] = [];
  renameFile(from: Uri, to: Uri): void {
    this.renames.push([from, to]);
  }
}

/** A file system watcher a test fires events on. */
export class FakeWatcher {
  readonly created = new EventEmitter<Uri>();
  readonly changed = new EventEmitter<Uri>();
  readonly deleted = new EventEmitter<Uri>();
  onDidCreate = this.created.event;
  onDidChange = this.changed.event;
  onDidDelete = this.deleted.event;
  disposed = false;
  constructor(
    public glob: string,
    public ignoreCreate = false,
    public ignoreChange = false,
    public ignoreDelete = false,
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

/** A Memento over recorded.workspaceState, for an ExtensionContext's workspaceState. */
export const workspaceState = {
  get<T>(key: string, fallback?: T): T | undefined {
    return recorded.workspaceState.has(key) ? (recorded.workspaceState.get(key) as T) : fallback;
  },
  update(key: string, value: unknown): Promise<void> {
    recorded.workspaceState.set(key, value);
    return Promise.resolve();
  },
  keys: () => [...recorded.workspaceState.keys()],
};

export class FakeWebview {
  html = '';
  posted: unknown[] = [];
  cspSource = 'vscode-resource:';
  private handlers: Listener<unknown>[] = [];
  postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }
  onDidReceiveMessage(handler: Listener<unknown>) {
    this.handlers.push(handler);
    return { dispose() {} };
  }
  asWebviewUri(uri: Uri): Uri {
    return uri;
  }
  /** Test side: a message from the page. */
  async receive(message: unknown): Promise<void> {
    await Promise.all(this.handlers.map((h) => h(message)));
  }
}

export class FakePanel {
  webview = new FakeWebview();
  active = true;
  visible = true;
  iconPath: unknown;
  revealed = 0;
  private viewState = new EventEmitter<void>();
  private disposed = new EventEmitter<void>();
  onDidChangeViewState = this.viewState.event;
  onDidDispose = this.disposed.event;
  constructor(
    public viewType: string,
    public title: string,
  ) {}
  reveal(): void {
    this.revealed++;
  }
  dispose(): void {
    this.disposed.fire();
  }
  /** Test side: the panel becomes hidden or shown. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.active = visible;
    this.viewState.fire();
  }
}

export class FakeTreeView {
  visible = true;
  description?: string;
  private visibility = new EventEmitter<{ visible: boolean }>();
  onDidChangeVisibility = this.visibility.event;
  constructor(
    public id: string,
    public options: { treeDataProvider: unknown },
  ) {}
  reveal(node: unknown, options?: unknown): Promise<void> {
    recorded.revealed.push({ view: this.id, node, options });
    return Promise.resolve();
  }
  dispose(): void {}
}

export const window = {
  createStatusBarItem(alignment: number, priority: number) {
    const item = new FakeStatusBarItem(alignment, priority);
    recorded.statusBarItems.push(item);
    return item;
  },
  onDidChangeActiveTextEditor(listener: Listener<unknown>) {
    recorded.editorListeners.push(listener);
    return { dispose() {} };
  },
  get activeTextEditor() {
    return recorded.activeEditor;
  },
  createWebviewPanel(viewType: string, title: string): FakePanel {
    const panel = new FakePanel(viewType, title);
    recorded.panels.push(panel);
    return panel;
  },
  createTreeView(id: string, options: { treeDataProvider: unknown }): FakeTreeView {
    const view = new FakeTreeView(id, options);
    recorded.treeViews.push(view);
    return view;
  },
  showInformationMessage(message: string, ...actions: unknown[]) {
    recorded.info.push(message);
    return Promise.resolve(actions.length && typeof actions[0] === 'string' ? recorded.infoAnswers.shift() : undefined);
  },
  showErrorMessage(message: string, options?: { modal?: boolean }) {
    recorded.errors.push(message);
    if (typeof options === 'object' && options?.modal) recorded.modalErrors.push(message);
    return Promise.resolve(undefined);
  },
  showQuickPick(items: unknown[]) {
    const choice = recorded.quickPicks.shift();
    return Promise.resolve(typeof choice === 'function' ? (choice as (i: unknown[]) => unknown)(items) : choice);
  },
  showInputBox(options: { validateInput?: (v: string) => string | undefined }) {
    const value = recorded.inputs.shift();
    if (value !== undefined && options.validateInput?.(value)) return Promise.resolve(undefined);
    return Promise.resolve(value);
  },
  showWarningMessage(message: string) {
    recorded.warnings.push(message);
    return Promise.resolve(recorded.warningAnswers.shift());
  },
  withProgress<T>(_options: unknown, task: (progress: { report(v: { message?: string }): void }, token: { onCancellationRequested(l: () => void): void }) => Promise<T>): Promise<T> {
    const progress = { report: (v: { message?: string }) => recorded.progress.push(v.message ?? '') };
    const token = { onCancellationRequested: (l: () => void) => (recorded.cancel = l) };
    return task(progress, token);
  },
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => recorded.output.push(line),
      show: () => undefined,
      dispose: () => undefined,
    };
  },
  showTextDocument(target: Uri | { content: string } | { uri: Uri; languageId: string }, options?: unknown) {
    recorded.shownOptions.push(options);
    if ('uri' in target) {
      recorded.shownDocuments.push(`${target.uri.toString()} (${target.languageId})`);
      return Promise.resolve(undefined);
    }
    recorded.shownDocuments.push(target instanceof Uri ? target.fsPath : target.content);
    return Promise.resolve(undefined);
  },
  showSaveDialog() {
    return Promise.resolve(recorded.saveDialog);
  },
  showOpenDialog() {
    return Promise.resolve(recorded.openDialog);
  },
};

export const extensions = {
  getExtension(id: string) {
    const api = recorded.extensions.get(id);
    return api === undefined ? undefined : { activate: () => Promise.resolve(api) };
  },
};

export const workspace = {
  asRelativePath(target: Uri | string) {
    const p = typeof target === 'string' ? target : target.fsPath;
    const folder = recorded.workspaceFolders?.find((f) => p.startsWith(`${f.uri.fsPath}/`));
    return folder ? p.slice(folder.uri.fsPath.length + 1) : p;
  },
  get textDocuments() {
    return recorded.textDocuments;
  },
  openTextDocument(options: { content: string; language: string } | Uri) {
    if (options instanceof Uri) return Promise.resolve({ uri: options, languageId: 'plaintext' });
    return Promise.resolve({ content: options.content, language: options.language });
  },
  get workspaceFolders() {
    return recorded.workspaceFolders;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const v = recorded.settings.get(`${section}.${key}`);
        return v === undefined ? fallback : (v as T);
      },
      update(key: string, value: unknown) {
        recorded.settings.set(`${section}.${key}`, value);
        return Promise.resolve();
      },
    };
  },
  findFiles(include: string) {
    return Promise.resolve((recorded.files.get(include) ?? []).map((p) => Uri.file(p)));
  },
  registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) {
    recorded.documentProviders.set(scheme, provider);
    return { dispose: () => recorded.documentProviders.delete(scheme) };
  },
  createFileSystemWatcher(glob: string, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean) {
    const watcher = new FakeWatcher(glob, ignoreCreate, ignoreChange, ignoreDelete);
    recorded.watchers.push(watcher);
    return watcher;
  },
  onDidChangeWorkspaceFolders(listener: Listener<unknown>) {
    recorded.folderListeners.push(listener);
    return { dispose() {} };
  },
  /** Applies a WorkspaceEdit's renames on the real file system, unless a test makes it fail. */
  async applyEdit(edit: WorkspaceEdit) {
    if (!recorded.applyEditResult) return false;
    const nodeFs = await import('node:fs/promises');
    for (const [from, to] of edit.renames) await nodeFs.rename(from.fsPath, to.fsPath);
    return true;
  },
  /** The real file system, except that delete records the path and moves nothing to a real trash. */
  fs: {
    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) {
      recorded.trashed.push(`${uri.fsPath}${options?.useTrash ? ' (trash)' : ''}`);
      const nodeFs = await import('node:fs/promises');
      await nodeFs.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
    },
    async rename(from: Uri, to: Uri) {
      const nodeFs = await import('node:fs/promises');
      await nodeFs.rename(from.fsPath, to.fsPath);
    },
  },
  onDidSaveTextDocument(listener: Listener<{ uri: Uri }>) {
    recorded.saveListeners.push(listener);
    return { dispose() {} };
  },
  onDidChangeConfiguration(listener: Listener<{ affectsConfiguration: (s: string) => boolean }>) {
    recorded.configListeners.push(listener);
    return { dispose() {} };
  },
};

export const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    recorded.commands.set(id, fn);
    return { dispose: () => recorded.commands.delete(id) };
  },
  executeCommand(id: string, ...args: unknown[]) {
    recorded.executed.push({ id, args });
    return Promise.resolve(undefined);
  },
};

export const env = {
  clipboard: {
    writeText(text: string) {
      recorded.clipboard.push(text);
      return Promise.resolve();
    },
  },
  openExternal(uri: Uri) {
    recorded.opened.push(uri.toString());
    return Promise.resolve(true);
  },
};
