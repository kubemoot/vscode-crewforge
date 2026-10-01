import * as vscode from 'vscode';
import type { SourceEntry } from '../source/service';
import { errorText } from '../views/errors';
import { showError } from '../views/notify';
import { lintSource, MissingToolError, type Finding, type LintDeps, type LintResult, type Severity } from './lint';

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** How long after the last save of a crew's file its lint runs, so a burst of saves lints once. */
export const SAVE_DEBOUNCE_MS = 750;

/**
 * Lint in the editor: runs the lint for one source and shows its findings in the
 * Problems panel, replacing that source's earlier findings. On save it lints the crew of
 * the saved file once the saves settle.
 */
export class CrewLinter implements vscode.Disposable {
  /** The files each source's last lint reported on, by source folder, to clear them next time. */
  private readonly reported = new Map<string, vscode.Uri[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private toldMissing = false;

  constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly deps: LintDeps,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Lints a source and says what it found; a missing tool is a message, not a failure. */
  async lintCommand(entry: SourceEntry): Promise<void> {
    const result = await this.run(entry, true);
    if (!result) return;
    const count = result.findings.filter((f) => f.severity !== 'info').length;
    void vscode.window.showInformationMessage([`Lint: ${entry.crewName ?? entry.source.label} has ${problemsFound(count)}.`, ...result.notes].join(' '));
  }

  /** Lints the saved file's crew once saves settle; `after` runs when it has. */
  lintOnSave(entry: SourceEntry, after?: (result?: LintResult) => void): void {
    const root = entry.source.root;
    clearTimeout(this.timers.get(root));
    this.timers.set(
      root,
      setTimeout(() => {
        this.timers.delete(root);
        void this.run(entry, false).then(after);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  /** Runs the lint and shows its findings; undefined when it could not run. */
  async run(entry: SourceEntry, loud: boolean): Promise<LintResult | undefined> {
    try {
      const result = await lintSource(entry.source, this.deps);
      this.show(entry.source.root, result.findings);
      return result;
    } catch (err) {
      this.report(err, loud);
      return undefined;
    }
  }

  private report(err: unknown, loud: boolean): void {
    this.output.appendLine(`Lint: ${errorText(err)}`);
    if (!(err instanceof MissingToolError)) {
      if (loud) void showError(err);
      return;
    }
    if (loud || !this.toldMissing) void vscode.window.showWarningMessage(err.message);
    this.toldMissing = true;
  }

  private show(root: string, findings: Finding[]): void {
    for (const uri of this.reported.get(root) ?? []) this.diagnostics.delete(uri);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), toDiagnostic(f)]);
    const uris: vscode.Uri[] = [];
    for (const [file, diagnostics] of byFile) {
      const uri = vscode.Uri.file(file);
      this.diagnostics.set(uri, diagnostics);
      uris.push(uri);
    }
    this.reported.set(root, uris);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function toDiagnostic(f: Finding): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(new vscode.Range(f.line, 0, f.line, Number.MAX_SAFE_INTEGER), f.message, SEVERITY[f.severity]);
  diagnostic.source = `CrewForge (${f.source})`;
  return diagnostic;
}

/** How many problems a lint found, as the message says it: "no problems", "1 problem; see the Problems panel". */
function problemsFound(count: number): string {
  if (count === 0) return 'no problems';
  const noun = count === 1 ? 'problem' : 'problems';
  return `${count} ${noun}; see the Problems panel`;
}
