import * as vscode from 'vscode';
import { candidates, dangling, declarationSpan, targetOf, type ReferenceIndex, type SourceNames } from './referenceIndex';
import { completionAt, declSites, nameAt, refSites, siteAt, TARGET_OF, type RefField, type TextSpan } from './references';

/** The languages whose references CrewForge follows: YAML, and the Helm templates of a chart. */
const REFERENCE_LANGUAGES = ['yaml', 'helm'];

export const REFERENCE_FILES: vscode.DocumentSelector = REFERENCE_LANGUAGES.map((language) => ({ language, scheme: 'file' }));

/** How long after the last keystroke the references of a document are checked again. */
export const CHECK_DEBOUNCE_MS = 400;

export interface LanguageDeps {
  index: ReferenceIndex;
  readText: (file: string) => Promise<string>;
}

const rangeOf = (s: TextSpan): vscode.Range => new vscode.Range(s.line, s.start, s.line, s.end);

/**
 * What CrewForge knows about a crew's own references, as editor features: Go to Definition
 * and Find All References for the PromptModules an Agent composes (promptRefs) and the Crew
 * an object belongs to (crewRef), a name list while typing one, and a warning on a name no
 * object of the crew source declares. The names come from the source's declarations, so a
 * chart is read the way it renders.
 */
export class ReferenceLanguage implements vscode.DefinitionProvider, vscode.ReferenceProvider, vscode.CompletionItemProvider, vscode.Disposable {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: LanguageDeps,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | undefined> {
    const site = siteAt(refSites(document.getText()), position.line, position.character);
    const names = site && (await this.deps.index.namesFor(document.uri.fsPath));
    const place = names && site && targetOf(names, site.field, site.name);
    if (!place || !site) return undefined;
    const span = declarationSpan(await this.textOf(place.file), place, site.field, site.name);
    return new vscode.Location(vscode.Uri.file(place.file), rangeOf(span));
  }

  async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
    const target = nameAt(document.getText(), position.line, position.character);
    const names = target && (await this.deps.index.namesFor(document.uri.fsPath));
    return names && target ? this.locationsOf(names, document, target.field, target.name, context.includeDeclaration) : [];
  }

  /** Every place the source writes `name` in `field`, and, when asked, where it is declared. */
  private async locationsOf(names: SourceNames, document: vscode.TextDocument, field: RefField, name: string, includeDeclaration: boolean): Promise<vscode.Location[]> {
    const files = [...new Set([document.uri.fsPath, ...names.files])];
    const found = await Promise.all(
      files.map(async (file) => {
        const text = file === document.uri.fsPath ? document.getText() : await this.textOf(file);
        const uses = refSites(text).filter((s) => s.field === field && s.name === name);
        const declarations = includeDeclaration ? declSites(text).filter((s) => s.kind === TARGET_OF[field] && s.name === name) : [];
        return [...uses, ...declarations].map((s) => new vscode.Location(vscode.Uri.file(file), rangeOf(s)));
      }),
    );
    return found.flat();
  }

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const site = completionAt(document.getText(), position.line, position.character);
    const names = site && (await this.deps.index.namesFor(document.uri.fsPath));
    if (!site || !names) return [];
    return candidates(names, site.field).map((c) => {
      const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Reference);
      item.detail = c.detail;
      item.range = new vscode.Range(site.line, site.start, site.line, site.end);
      return item;
    });
  }

  /** Warns, in the Problems panel, about each reference of the document that names nothing the source declares. */
  async check(document: vscode.TextDocument): Promise<void> {
    const names = await this.deps.index.namesFor(document.uri.fsPath);
    if (document.isClosed) return;
    const found = names ? dangling(names, refSites(document.getText())) : [];
    if (found.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }
    this.diagnostics.set(
      document.uri,
      found.map((d) => {
        const diagnostic = new vscode.Diagnostic(rangeOf(d.site), d.message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'CrewForge (references)';
        return diagnostic;
      }),
    );
  }

  /** Checks a document once its edits settle. */
  checkLater(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(document);
      }, CHECK_DEBOUNCE_MS),
    );
  }

  /** Forgets a closed document: its pending check, and the warnings it had. */
  closed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.diagnostics.delete(document.uri);
  }

  /** Checks every open document again, after the sources loaded. */
  checkAll(): void {
    this.deps.index.invalidate();
    for (const document of vscode.workspace.textDocuments) if (isReferenceFile(document)) void this.check(document);
  }

  /** The text of a file: its open document, or the file as saved. */
  private async textOf(file: string): Promise<string> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    return open ? open.getText() : this.deps.readText(file).catch(() => '');
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export const isReferenceFile = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file' && REFERENCE_LANGUAGES.includes(document.languageId);

/** Registers the reference features; `onSourcesLoaded` is when the sources load or change. */
export function registerReferenceLanguage(context: vscode.ExtensionContext, deps: LanguageDeps, onSourcesLoaded: vscode.Event<unknown>): ReferenceLanguage {
  const diagnostics = vscode.languages.createDiagnosticCollection('crewforge-references');
  const language = new ReferenceLanguage(deps, diagnostics);
  context.subscriptions.push(
    diagnostics,
    language,
    vscode.languages.registerDefinitionProvider(REFERENCE_FILES, language),
    vscode.languages.registerReferenceProvider(REFERENCE_FILES, language),
    vscode.languages.registerCompletionItemProvider(REFERENCE_FILES, language, ' ', '[', ',', '"'),
    onSourcesLoaded(() => language.checkAll()),
    vscode.workspace.onDidOpenTextDocument((d) => isReferenceFile(d) && language.checkLater(d)),
    vscode.workspace.onDidChangeTextDocument((e) => isReferenceFile(e.document) && language.checkLater(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => language.closed(d)),
  );
  return language;
}
