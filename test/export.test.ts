import { describe, expect, it } from 'vitest';
import { newConversation } from '../src/store/conversation';
import { exportAsMarkdown, exportFileName } from '../src/store/export';

function sample() {
  const c = newConversation('ctx', 'team-1', 'lab-ops', new Date('2026-09-27T01:00:00Z'));
  c.title = 'Which nodes have a GPU?';
  c.conversationId = 'conv-1';
  c.messages.push(
    { role: 'user', content: 'Which nodes have a GPU?', timestamp: '2026-09-27T01:00:01Z' },
    { role: 'assistant', content: 'Two: **rig0** and rig1.', timestamp: '2026-09-27T01:00:40Z', agentName: 'Crew' },
  );
  c.signals.push({ type: 'agree', agentName: 'node-watcher', timestamp: '2026-09-27T01:00:30Z' });
  return c;
}

describe('exportAsMarkdown', () => {
  it('writes the header, the messages, and the signals', () => {
    const md = exportAsMarkdown(sample());
    expect(md).toContain('# Which nodes have a GPU?');
    expect(md).toContain('**Crew:** lab-ops (namespace team-1, context ctx)');
    expect(md).toContain('**Conversation:** `conv-1`');
    expect(md).toContain('### You (2026-09-27T01:00:01Z)\n\nWhich nodes have a GPU?');
    expect(md).toContain('### Crew (2026-09-27T01:00:40Z)\n\nTwo: **rig0** and rig1.');
    expect(md).toContain('## Agent activity');
    expect(md).toContain('- **node-watcher**: agree (2026-09-27T01:00:30Z)');
    expect(md).not.toContain('signal');
  });

  it('writes how long a turn took and what went wrong, when known', () => {
    const c = sample();
    c.messages[1].durationMs = 42_000;
    c.messages[1].problems = ['k8s failed: tool error', 7 as unknown as string];
    c.messages.push({ role: 'system', content: 'Stopped.', timestamp: '2026-09-27T01:02:00Z', problems: 'not a list' as unknown as string[] });
    const md = exportAsMarkdown(c);
    expect(md).toContain('### Crew (2026-09-27T01:00:40Z, took 42 s)\n\nTwo: **rig0** and rig1.\n\nWhat went wrong:\n\n- k8s failed: tool error\n');
    expect(md).not.toContain('- 7');
    expect(md).toContain('### Crew (2026-09-27T01:02:00Z)\n\nStopped.\n');
    expect(md.match(/What went wrong/g)).toHaveLength(1);
  });

  it('leaves out the signals section and conversation id when there are none', () => {
    const c = newConversation('ctx', 'ns', 'crew');
    const md = exportAsMarkdown(c);
    expect(md).not.toContain('Agent activity');
    expect(md).not.toContain('Conversation:');
  });
});

describe('exportFileName', () => {
  it('is the crew and the title words', () => {
    expect(exportFileName(sample())).toBe('lab-ops-Which-nodes-have-a-GPU.md');
  });

  it('falls back when the title has no usable characters', () => {
    const c = newConversation('ctx', 'ns', 'crew');
    c.title = '???';
    expect(exportFileName(c)).toBe('crew-conversation.md');
  });
});
