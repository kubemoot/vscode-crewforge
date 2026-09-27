import type { Conversation } from './conversation';

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

  for (const m of c.messages) {
    const label = m.role === 'user' ? 'You' : m.agentName || 'Crew';
    lines.push(`### ${label} (${m.timestamp})`, '', m.content, '');
  }

  if (c.signals.length > 0) {
    lines.push('---', '', '## Agent signals', '');
    for (const s of c.signals) lines.push(`- **${s.agentName}**: ${s.type} (${s.timestamp})`);
    lines.push('');
  }
  return lines.join('\n');
}

/** A file name for an export: crew, then the title's words. */
export function exportFileName(c: Conversation): string {
  const words = c.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return `${c.crewName}-${words || 'conversation'}.md`;
}
