import { isConnectionProblem, KubeError } from '../k8s/request';
import type { SourceLocation } from '../source/render';

/** The text of any thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A tree label for an error: its first line, cut at the first sentence; the full text goes in the tooltip. */
export function errorLabel(message: string): string {
  const line = message.split('\n')[0];
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

/** The raw error behind a plain message, such as "connect ECONNREFUSED 127.0.0.1:6443", when it says more than the message. */
export function rawDetail(err: unknown): string | undefined {
  const raw = err instanceof KubeError ? err.detail : undefined;
  return raw && !errorText(err).includes(raw) ? raw : undefined;
}

/** The line that carries a raw error under its plain message. */
export function detailLine(raw: string): string {
  return `Details: ${raw}`;
}

/** The error's message, and the raw error behind it when that says more, for a tooltip or a bug report. */
export function errorDetail(err: unknown): string {
  const raw = rawDetail(err);
  return raw ? `${errorText(err)}\n\n${detailLine(raw)}` : errorText(err);
}

/** Why the cluster could not be read: a connection problem says it plainly already; anything else is prefixed so it reads as one. */
export function unreachableReason(err: unknown): string {
  return isConnectionProblem(err) ? errorText(err) : `Cannot reach the cluster: ${errorText(err)}`;
}

/** The action offered wherever a cluster cannot be reached. */
export const SELECT_CONTEXT = { command: 'crewforge.selectContext', title: 'Select Kubernetes Context' } as const;

/** A tree's item for a message: what it says, its tooltip, its icon, and what a click does. */
export interface MessageNode {
  kind: 'message';
  text: string;
  detail?: string;
  icon?: string;
  /** The file and line the message points at, which a click opens. */
  at?: SourceLocation;
  command?: { command: string; title: string };
}

/**
 * A tree's items for a failure: its first sentence (the whole error and its raw detail on
 * hover, and the place it points at), then Select Kubernetes Context when another context
 * may help.
 */
export function errorItems(err: unknown, at?: SourceLocation): MessageNode[] {
  const items: MessageNode[] = [{ kind: 'message', text: errorLabel(errorText(err)), detail: errorDetail(err), ...(at ? { at } : {}) }];
  if (isConnectionProblem(err)) items.push({ kind: 'message', text: `${SELECT_CONTEXT.title}...`, detail: 'Pick another context from the kubeconfig.', icon: 'server-environment', command: { ...SELECT_CONTEXT } });
  return items;
}
