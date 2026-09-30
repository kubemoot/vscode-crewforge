import * as vscode from 'vscode';
import { sourceOf, type SourceEntry } from '../source/service';
import { stateText, type CrewState, type LoopStates } from './state';

/**
 * The status bar item of the inner loop: while the active file belongs to a crew source,
 * it names the crew and where it stands against its dev deployment (not deployed,
 * deployed and in sync, changed since deploy). Clicking it offers the next steps.
 */
export class CrewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private current?: SourceEntry;

  constructor(
    private readonly known: () => SourceEntry[],
    private readonly states: LoopStates,
    private readonly refreshState: (entry: SourceEntry) => Promise<unknown>,
  ) {}

  /** Shows the crew of `file`, or hides the item when the file belongs to no crew source. */
  update(file?: string): void {
    const entry = file ? sourceOf(this.known(), file) : undefined;
    this.current = entry?.crewName ? entry : undefined;
    if (!this.current) {
      this.item.hide();
      return;
    }
    const state = this.states.get(this.current.source.root);
    this.draw(this.current, state);
    if (!state) void this.refreshState(this.current).catch(() => undefined);
  }

  /** Redraws the item when the shown crew's state changes. */
  stateChanged(root: string): void {
    if (this.current?.source.root === root) this.draw(this.current, this.states.get(root));
  }

  private draw(entry: SourceEntry, state?: CrewState): void {
    const words = state ? stateText(state) : 'checking...';
    this.item.text = `$(${state?.kind === 'changed' ? 'diff' : 'organization'}) ${entry.crewName}: ${words}`;
    this.item.tooltip = `CrewForge: crew ${entry.crewName} from ${entry.source.root}\n${words}\nClick for the next steps.`;
    this.item.command = { command: 'crewforge.crewActions', title: 'Crew Actions', arguments: [{ kind: 'source', entry }] };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
