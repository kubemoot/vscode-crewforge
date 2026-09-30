import { formatDuration, trimBoth } from '../text';
import { problemsOf, type ChatMessage, type Conversation } from './conversation';

/** A conversation as Markdown: header, every message, then the agents' signals. */
export function exportAsMarkdown(c: Conversation): string {
  const lines: string[] = [
    `# ${c.title}`,
    '',
    `**Crew:** ${c.crewName} (namespace ${c.namespace}, context ${c.context})`,
    `**Started:** ${c.startedAt}`,
  ];
  if (c.conversationId) lines.push(`**Conversation:** \`${c.conversationId}\``);
  lines.push('', '---', '');

  for (const m of c.messages) lines.push(...messageLines(m));

  if (c.signals.length > 0) {
    lines.push('---', '', '## Agent activity', '');
    for (const s of c.signals) lines.push(`- **${s.agentName}**: ${s.type} (${s.timestamp})`);
    lines.push('');
  }
  return lines.join('\n');
}

/** One message: who and when (with how long the turn took, when known), its text, and what went wrong. */
function messageLines(m: ChatMessage): string[] {
  const label = m.role === 'user' ? 'You' : m.agentName || 'Crew';
  const took = formatDuration(m.durationMs);
  const lines = [`### ${label} (${m.timestamp}${took ? `, took ${took}` : ''})`, '', m.content, ''];
  const problems = problemsOf(m);
  if (problems.length > 0) lines.push('What went wrong:', '', ...problems.map((p) => `- ${p}`), '');
  return lines;
}

/** A file name for an export: crew, then the title's words. */
export function exportFileName(c: Conversation): string {
  const words = trimBoth(c.title.replaceAll(/[^A-Za-z0-9]+/g, '-'), '-').slice(0, 50);
  return `${c.crewName}-${words || 'conversation'}.md`;
}
