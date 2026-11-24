import * as vscode from 'vscode';
import {
  CONTROLLER_ROLE,
  controlConversation,
  ControlError,
  reportControl,
  eraseConversation,
  type EraseOptions,
  erasureLines,
  erasureSummary,
  MAX_REASON,
  reasonProblem,
  type ConversationErasure,
} from '../discussion/controls';
import type { ControlAction } from '../discussion/gatewayPath';
import type { KubeTransport } from '../k8s/request';
import { confirmModal } from '../views/confirm';

/** What a person can do to a conversation on the crew, beyond what they ask in it. */
export type ConversationActionId = ControlAction | 'erase';

const ACTIONS: readonly string[] = ['stop', 'pause', 'resume', 'erase'];

/** Whether a value from the page names an action; the page is not trusted. */
export function isConversationAction(value: unknown): value is ConversationActionId {
  return typeof value === 'string' && ACTIONS.includes(value);
}

/** The conversation an action is for: the gateway's id, and the name a person knows it by. */
export interface ConversationTarget {
  conversationId: string;
  title: string;
}

/**
 * Stops, pauses, resumes or deletes a conversation on one crew through its gateway. The
 * gateway lets the owner act without a reason; anyone else needs the
 * `kubemoot-conversation-controller` role and says why. CrewForge cannot tell who owns a
 * conversation, so it asks without a reason first, and asks the person for one only when
 * the gateway says one is needed.
 */
export class ConversationActions {
  constructor(
    private readonly client: KubeTransport,
    private readonly namespace: string,
    private readonly crew: string,
  ) {}

  /** Runs `action` on the conversation; a failure is thrown for the caller to show. True when the crew took it, false when the person declined. */
  async run(action: ConversationActionId, target: ConversationTarget): Promise<boolean> {
    return action === 'erase' ? this.erase(target) : this.control(action, target);
  }

  private async control(action: ControlAction, target: ConversationTarget): Promise<boolean> {
    let reason: string | undefined;
    for (;;) {
      try {
        const sent = await controlConversation(this.client, this.namespace, this.crew, target.conversationId, action, reason);
        const report = reportControl(action, target.title, sent);
        void (report.warn ? vscode.window.showWarningMessage(report.text) : vscode.window.showInformationMessage(report.text));
        return true;
      } catch (err) {
        if (!needsReason(err) || reason !== undefined) throw err;
        reason = await askReason(`${action} "${target.title}"`);
        if (reason === undefined) return false;
      }
    }
  }

  /**
   * Deletes the conversation from the crew after asking, then shows what was removed and
   * what cannot be. A conversation that is still running is deleted only when the person
   * chooses Stop and delete.
   */
  private async erase(target: ConversationTarget): Promise<boolean> {
    const sure = await confirmModal(
      `Delete "${target.title}" from the crew?`,
      'Delete from crew',
      "This removes the conversation from every place the crew keeps it: its history, the agents' messages, workspace, scheduled reminders and learned memory facts. The copy on this computer stays. This cannot be undone.",
    );
    if (!sure) return false;
    const asked: EraseOptions = {};
    for (;;) {
      try {
        showErasure(await eraseConversation(this.client, this.namespace, this.crew, target.conversationId, asked));
        return true;
      } catch (err) {
        if (!(await this.resolve(err, asked, target))) return false;
      }
    }
  }

  /**
   * Settles what stands in the way of a delete by asking: a reason, then whether to stop a
   * running discussion. False when the person declines or the failure is something else to throw.
   */
  private async resolve(err: unknown, asked: EraseOptions, target: ConversationTarget): Promise<boolean> {
    if (needsReason(err) && asked.reason === undefined) {
      asked.reason = await askReason(`delete "${target.title}"`);
      return asked.reason !== undefined;
    }
    if (err instanceof ControlError && err.running && !asked.force) {
      asked.force = await confirmModal(`"${target.title}" is still running.`, 'Stop and delete', 'The crew stops it first, then the conversation is deleted.');
      return asked.force;
    }
    throw err;
  }
}

function needsReason(err: unknown): boolean {
  return err instanceof ControlError && err.needsReason;
}

/** Asks why the person acts on another caller's conversation; undefined when they cancel. The gateway audits it. */
export async function askReason(what: string): Promise<string | undefined> {
  const reason = await vscode.window.showInputBox({
    title: `Reason to ${what}`,
    prompt: `This is another caller's conversation, and acting on it needs the ${CONTROLLER_ROLE} role and a reason (1 to ${MAX_REASON} characters). The crew records the reason in its audit log.`,
    validateInput: reasonProblem,
  });
  return reason?.trim() || undefined;
}

/** Tells the person what a delete removed, store by store, and what it cannot remove. */
function showErasure(report: ConversationErasure): void {
  void vscode.window.showInformationMessage(erasureSummary(report), { modal: true, detail: erasureLines(report).join('\n') });
}
