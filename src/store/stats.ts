import type { ConversationStats } from '../dashboard/crewVitals';
import { problemsOf, type Conversation } from './conversation';
import type { ConversationStore } from './conversations';

/** How many saved conversations a dashboard reads, newest first. */
const READ_LIMIT = 50;
/** How many recent problems it shows. */
const PROBLEM_LIMIT = 5;

/**
 * What CrewForge's saved conversations with a crew say: how many there are, how many
 * turns they hold (questions asked), and the newest problems saved with a turn (a failed
 * or unfinished agent, a gateway error, a timeout, a stop). `active` is the question of a
 * turn running now in an open chat.
 */
export async function conversationStats(store: ConversationStore, context: string, namespace: string, crew: string, active?: string): Promise<ConversationStats> {
  const metas = await store.list(context, namespace, crew);
  const loaded = await Promise.all(metas.slice(0, READ_LIMIT).map((m) => store.load(m).catch(() => undefined)));
  const conversations = loaded.filter((c): c is Conversation => c !== undefined);
  const turns = conversations.reduce((n, c) => n + c.messages.filter((m) => m.role === 'user').length, 0);
  const errors = conversations
    .flatMap((c) => c.messages.flatMap((m) => problemsOf(m).map((text) => ({ at: m.timestamp, text }))))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, PROBLEM_LIMIT);
  return { total: metas.length, turns, active, errors };
}
