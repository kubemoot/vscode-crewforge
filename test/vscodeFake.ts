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
export const ViewColumn = { Active: -1 } as const;
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
  ) {}
  static file(p: string): Uri {
    return new Uri(p, `file://${p}`);
  }
  static parse(s: string): Uri {
    return new Uri(s, s);
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
  documentProviders: new Map<string, { provideTextDocumentContent(uri: Uri): string }>(),
};

export function resetFake(): void {
  recorded.commands.clear();
  recorded.executed = [];
  recorded.info = [];
  recorded.errors = [];
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
}

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
  dispose(): void {}
}

export const window = {
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
  showInformationMessage(message: string) {
    recorded.info.push(message);
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string) {
    recorded.errors.push(message);
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
  withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
    return task();
  },
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => recorded.output.push(line),
      show: () => undefined,
      dispose: () => undefined,
    };
  },
  showTextDocument(target: Uri | { content: string }) {
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

export const workspace = {
  openTextDocument(options: { content: string; language: string }) {
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
