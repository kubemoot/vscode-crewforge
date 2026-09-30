/**
 * A conversation with one crew, saved as CrewForge's DiscussionJournal plus where the
 * crew lives and the gateway's ids, so a saved conversation can be continued.
 */
export interface Conversation {
  id: string;
  crewName: string;
  title: string;
  startedAt: string;
  messages: ChatMessage[];
  signals: ChatSignal[];
  context: string;
  namespace: string;
  /** The gateway's conversation id, sent with every later message. */
  conversationId?: string;
  /** The discussion thread behind each turn, in order. */
  threadIds: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentName?: string;
}

export interface ChatSignal {
  type: string;
  agentName: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** What a list of saved conversations shows. */
export interface ConversationMeta {
  id: string;
  title: string;
  startedAt: string;
  crewName: string;
  namespace: string;
  context: string;
}

export function newConversation(context: string, namespace: string, crewName: string, now = new Date()): Conversation {
  return {
    id: now.toISOString().replaceAll(/[:.]/g, '-'),
    crewName,
    title: 'New conversation',
    startedAt: now.toISOString(),
    messages: [],
    signals: [],
    context,
    namespace,
    threadIds: [],
  };
}

/** A conversation's title is its first question, cut to a line's length. */
export function titleFrom(question: string): string {
  const oneLine = question.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}...` : oneLine || 'Untitled';
}

export function metaOf(c: Conversation): ConversationMeta {
  return { id: c.id, title: c.title, startedAt: c.startedAt, crewName: c.crewName, namespace: c.namespace, context: c.context };
}
