import * as vscode from 'vscode';
import type { SourceEntry } from '../source/service';

/** Asks which crew source, each listed by its crew name (else its folder), what it is, and where; `empty` is the prompt when there is none. */
export async function pickSource(entries: SourceEntry[], placeHolder: string, empty: string): Promise<SourceEntry | undefined> {
  const items = entries.map((entry) => ({ label: entry.crewName ?? entry.source.label, description: entry.source.kind, detail: entry.source.root, entry }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: entries.length ? placeHolder : empty });
  return choice?.entry;
}
