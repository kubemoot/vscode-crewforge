import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { crewTitle } from '../crew/displayName';
import type { CrewSummary } from '../k8s/crews';
import { isConnectionProblem } from '../k8s/request';
import { memoryConnection, type MemoryConnection } from '../memory/connect';
import { MemoryError, type MemoryRead } from '../memory/relay';
import { mintableAccounts, TOKEN_SETTING } from '../memory/serviceAccounts';
import { errorDetail, errorText, SELECT_CONTEXT } from '../views/errors';
import { renderMemoryPage, type MemoryView } from './memoryPage';
import type { PageModel } from './pagePanel';

/** The file name of the saved export. */
export function exportFileName(crew: string): string {
  return `${crew}-memory-ompi.zip`;
}

/** The read-only memory page of one crew. It reads on open and on Refresh; the operator is asked nothing in between. */
export class MemoryDashboard implements PageModel {
  private last?: MemoryRead;
  private view: MemoryView;

  constructor(
    private readonly crew: CrewSummary,
    private readonly connect: () => MemoryConnection = memoryConnection,
  ) {
    this.view = { crew: crew.name, title: crewTitle({ crew }), namespace: crew.namespace, context: '' };
  }

  title(): string {
    return `${this.view.title} memory`;
  }

  async render(): Promise<string> {
    this.view = await this.read();
    return renderMemoryPage(this.view);
  }

  /** The memory is read when the person asks (open, Refresh), not on a timer. */
  refreshMs(): undefined {
    return undefined;
  }

  /** The connection of the last read, to look up ServiceAccounts through. */
  private connection?: MemoryConnection;

  private async read(): Promise<MemoryView> {
    const base: MemoryView = { crew: this.crew.name, title: this.view.title, namespace: this.crew.namespace, context: '' };
    try {
      const connection = this.connect();
      this.connection = connection;
      base.context = connection.context;
      this.last = await connection.relay.read(this.crew.namespace, this.crew.name);
      return { ...base, parsed: this.last.parsed, report: this.last.report };
    } catch (err) {
      this.last = undefined;
      const needsToken = err instanceof MemoryError && err.needsToken;
      return { ...base, error: needsToken ? errorText(err) : errorDetail(err), contextProblem: isConnectionProblem(err), needsToken };
    }
  }

  readonly actions: PageModel['actions'] = {
    refresh: async () => undefined,
    exportZip: () => this.exportZip(),
    chooseAccount: () => this.chooseAccount(),
    openTokenSetting: async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', TOKEN_SETTING);
    },
    selectContext: async () => {
      await vscode.commands.executeCommand(SELECT_CONTEXT.command);
    },
  };

  /**
   * Offers the ServiceAccounts the caller may create a token for, and keeps the one picked
   * in the setting the chat uses too. The page reads again once the action ends.
   */
  private async chooseAccount(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const found = await mintableAccounts(connection.client, [this.crew.namespace, connection.operatorNamespace]);
    if (found.length === 0) {
      void vscode.window.showInformationMessage(`No ServiceAccount in ${this.crew.namespace} or ${connection.operatorNamespace} lets you create tokens. Ask your cluster administrator for one, then set ${TOKEN_SETTING} to NAMESPACE/NAME.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(found, { placeHolder: 'Read the memory as which ServiceAccount? CrewForge mints a ten-minute token for it.' });
    if (!picked) return;
    await vscode.workspace.getConfiguration('crewforge').update('tokenServiceAccount', picked, vscode.ConfigurationTarget.Global);
  }

  /** Asks for a folder and saves the zip as read on the page there. */
  private async exportZip(): Promise<void> {
    const read = this.last;
    if (!read) return;
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export Here', title: `Export the memory of ${this.crew.name}` });
    if (!picked?.[0]) return;
    const target = path.join(picked[0].fsPath, exportFileName(this.crew.name));
    try {
      fs.writeFileSync(target, read.zip, { flag: 'wx' });
    } catch (err) {
      const exists = (err as { code?: string }).code === 'EEXIST';
      const why = exists ? `${target} already exists; pick another folder or move it.` : `could not save ${target}: ${errorText(err)}`;
      void vscode.window.showErrorMessage(`CrewForge: ${why}`);
      return;
    }
    void vscode.window.showInformationMessage(`Saved the memory export of ${this.crew.name} to ${target}.`);
  }
}
