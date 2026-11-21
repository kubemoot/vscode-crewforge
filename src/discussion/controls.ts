import { KubeError, type KubeTransport } from '../k8s/request';
import { controlPath, erasePath, type ControlAction } from './gatewayPath';

/** The header an operator acting on another caller's conversation gives the reason in. */
export const ACCESS_REASON_HEADER = 'Kubemoot-Access-Reason';

/** The role that lets an operator stop, pause, resume or delete another caller's conversations. */
export const CONTROLLER_ROLE = 'kubemoot-conversation-controller';

/** The longest reason the gateway takes. */
export const MAX_REASON = 200;

/** The gateway's answer to a stop, pause or resume: what it sent, and to which threads. */
export interface ConversationControl {
  conversationId: string;
  action: ControlAction;
  threads: string[];
}

/** What a delete removed from each store that held the conversation. */
export interface ErasureCounts {
  history: number;
  owner: number;
  discussionMessages: number;
  workspaceObjects: number;
  coordinatorEvents: number;
  scheduled: number;
  memoryFacts: number;
}

/** The gateway's answer to a delete: what it removed, and what it cannot remove. */
export interface ConversationErasure {
  conversationId: string;
  threads?: string[];
  deleted: ErasureCounts;
  kept: string[];
  /** The stores that could not be cleared, on a failed delete; repeating the delete removes what is left. */
  failed?: string[];
}

/** A control or delete that failed, said in plain words, with the status the gateway answered. */
export class ControlError extends KubeError {
  constructor(
    message: string,
    status: number | undefined,
    detail: string | undefined,
    /** The caller has to say why: they act on another caller's conversation. */
    readonly needsReason = false,
    /** The conversation still has a running discussion, so a delete needs `force`. */
    readonly running = false,
  ) {
    super(message, status, detail);
    this.name = 'ControlError';
  }
}

/** Why a reason is not acceptable, or undefined when it is: 1 to 200 characters. */
export function reasonProblem(value: string): string | undefined {
  const reason = value.trim();
  if (!reason) return 'Enter a reason.';
  return reason.length > MAX_REASON ? `Use at most ${MAX_REASON} characters (this is ${reason.length}).` : undefined;
}

function headersFor(reason?: string): Record<string, string> | undefined {
  return reason === undefined ? undefined : { [ACCESS_REASON_HEADER]: reason.trim() };
}

function parse<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The discussion gateway answered ${what} with something that is not JSON: ${text.slice(0, 200)}`);
  }
}

/** Sends a stop, pause or resume to the conversation's running threads. */
export async function controlConversation(
  client: KubeTransport,
  namespace: string,
  crew: string,
  conversationId: string,
  action: ControlAction,
  reason?: string,
): Promise<ConversationControl> {
  try {
    const text = await client.request('POST', controlPath(namespace, crew, conversationId, action), undefined, undefined, headersFor(reason));
    return parse<ConversationControl>(text, `the ${action}`);
  } catch (err) {
    throw describeControlFailure(err, { crew, action });
  }
}

/** What a delete asks: erase a running conversation too, and why an operator may act on another caller's. */
export interface EraseOptions {
  force?: boolean;
  reason?: string;
}

/** Erases the conversation from every store that holds it, and returns what was removed. */
export async function eraseConversation(
  client: KubeTransport,
  namespace: string,
  crew: string,
  conversationId: string,
  options: EraseOptions = {},
): Promise<ConversationErasure> {
  try {
    const text = await client.request('DELETE', erasePath(namespace, crew, conversationId, options.force), undefined, undefined, headersFor(options.reason));
    return parse<ConversationErasure>(text, 'the delete');
  } catch (err) {
    throw describeControlFailure(err, { crew, action: 'delete' });
  }
}

/** What an error names about the request that failed. */
interface Request {
  crew: string;
  action: ControlAction | 'delete';
}

/** The `error` the gateway wrote in a body, which a KubeError keeps in its detail. */
function gatewayMessage(detail: string | undefined): string {
  const found = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail ?? '');
  return found ? found[1].replaceAll(/\\(.)/g, '$1') : '';
}

/** The stores a failed delete says it could not clear, read from the report in the error's detail. */
function failedStores(detail: string | undefined): string[] {
  const found = /"failed"\s*:\s*\[([^\]]*)/.exec(detail ?? '');
  return found ? [...found[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

/** How a failure with a given status reads for one request, given what the gateway said. */
type Describe = (err: KubeError, request: Request, said: string) => KubeError;

function verbOf(request: Request): string {
  return request.action;
}

function badRequest(err: KubeError, request: Request, said: string): KubeError {
  if (said.includes(ACCESS_REASON_HEADER)) {
    return new ControlError(`This conversation belongs to another caller. To ${verbOf(request)} it, give a reason of 1 to ${MAX_REASON} characters.`, 400, err.detail, true);
  }
  const why = said ? `: ${said}` : '.';
  return new ControlError(`The discussion gateway did not accept the ${verbOf(request)}${why}`, 400, err.detail);
}

function notFound(err: KubeError, request: Request): KubeError {
  return new ControlError(`${err.message} To ${verbOf(request)} another caller's conversation you need the ${CONTROLLER_ROLE} role.`, 404, err.detail);
}

function conflict(err: KubeError, request: Request, said: string): KubeError {
  if (request.action === 'delete') {
    return new ControlError('The conversation still has a running discussion. Stop it first, or choose Stop and delete.', 409, err.detail, false, true);
  }
  const why = said ? ` (${said})` : '';
  return new ControlError(`The conversation has no running discussion to ${request.action}${why}.`, 409, err.detail);
}

function failed(err: KubeError, request: Request): KubeError {
  if (request.action !== 'delete') return new ControlError(`The crew ${request.crew} failed to ${request.action} the conversation.`, 500, err.detail);
  const stores = failedStores(err.detail);
  const which = stores.length > 0 ? ` These stores could not be cleared: ${stores.join(', ')}.` : '';
  return new ControlError(`The delete did not finish.${which} The conversation is still on the crew, so delete it again to remove what is left.`, 500, err.detail);
}

function unavailable(err: KubeError, request: Request, said: string): KubeError {
  const why = said || 'its gateway is not ready';
  return new ControlError(`The crew ${request.crew} could not ${verbOf(request)} the conversation right now (${why}). Try again in a moment.`, 503, err.detail);
}

/** What each status reads as. A 401 and a 403 are absent: they read plainly already, and keep their text. */
const DESCRIBE: Record<number, Describe> = { 400: badRequest, 404: notFound, 409: conflict, 500: failed, 503: unavailable };

/**
 * A refusal or failure of a control or a delete in plain words. A 401, 403 and 404 already
 * read plainly by the time they leave the gateway client (what the crew needs, and that the
 * conversation is not the caller's), so they keep their text; a 404 gains what an operator
 * needs. Anything that is not an HTTP status is returned as it came.
 */
export function describeControlFailure(err: unknown, request: Request): unknown {
  if (!(err instanceof KubeError) || err.status === undefined) return err;
  return DESCRIBE[err.status]?.(err, request, gatewayMessage(err.detail)) ?? err;
}

/** The rows of an erasure report: what each store lost, in the order the gateway names them. */
const STORES: Array<[keyof ErasureCounts, string]> = [
  ['history', 'conversation history'],
  ['owner', 'owner record'],
  ['discussionMessages', 'discussion messages'],
  ['workspaceObjects', 'workspace objects'],
  ['coordinatorEvents', 'coordinator events'],
  ['scheduled', 'scheduled reminders and follow-ups'],
  ['memoryFacts', 'crew memory facts'],
];

/** The report as lines to read: what was removed from each store, then what the gateway cannot remove. */
export function erasureLines(report: ConversationErasure): string[] {
  const lines = ['Removed:', ...STORES.map(([key, label]) => `  ${label}: ${report.deleted?.[key] ?? 0}`)];
  const kept = report.kept ?? [];
  if (kept.length > 0) lines.push('', 'Not removed:', ...kept.map((k) => `  ${k}`));
  return lines;
}

/** One line for a notification: how many things were removed from how many threads. */
export function erasureSummary(report: ConversationErasure): string {
  const total = STORES.reduce((sum, [key]) => sum + (report.deleted?.[key] ?? 0), 0);
  const threads = report.threads?.length ?? 0;
  const where = threads === 1 ? '1 thread' : `${threads} threads`;
  return `Deleted the conversation from the crew: ${total} items removed across ${where}.`;
}
