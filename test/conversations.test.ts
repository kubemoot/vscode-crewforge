import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newConversation, titleFrom } from '../src/store/conversation';
import { ConversationStore, safeSegment } from '../src/store/conversations';

const store = () => new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-store-')));

describe('ConversationStore', () => {
  it('saves and loads a conversation under context, namespace and crew', async () => {
    const s = store();
    const c = newConversation('admin@homelab-k8s-1', 'team-1', 'lab-ops', new Date('2026-09-27T01:02:03.456Z'));
    c.messages.push({ role: 'user', content: 'hi', timestamp: c.startedAt });
    c.conversationId = 'conv-1';
    await s.save(c);
    expect(s.file(c)).toBe(path.join(s.root, 'admin_homelab-k8s-1', 'team-1', 'lab-ops', '2026-09-27T01-02-03-456Z.json'));
    expect(await s.load(c)).toEqual(c);
    expect(fs.readdirSync(path.dirname(s.file(c)))).toEqual(['2026-09-27T01-02-03-456Z.json']);
  });

  it('lists one crew newest first and everything with listAll', async () => {
    const s = store();
    const older = newConversation('ctx', 'ns', 'a', new Date('2026-09-01T00:00:00Z'));
    const newer = newConversation('ctx', 'ns', 'a', new Date('2026-09-02T00:00:00Z'));
    const other = newConversation('ctx2', 'ns2', 'b', new Date('2026-09-03T00:00:00Z'));
    await Promise.all([s.save(older), s.save(newer), s.save(other)]);
    expect((await s.list('ctx', 'ns', 'a')).map((m) => m.id)).toEqual([newer.id, older.id]);
    expect((await s.listAll()).map((m) => m.crewName)).toEqual(['b', 'a', 'a']);
  });

  it('returns nothing for a crew with no conversations or a missing root', async () => {
    expect(await store().list('ctx', 'ns', 'none')).toEqual([]);
    expect(await new ConversationStore('/nonexistent/crewforge').listAll()).toEqual([]);
  });

  it('skips files it cannot read', async () => {
    const s = store();
    const c = newConversation('ctx', 'ns', 'crew');
    await s.save(c);
    fs.writeFileSync(path.join(s.dir('ctx', 'ns', 'crew'), 'broken.json'), '{not json');
    fs.writeFileSync(path.join(s.dir('ctx', 'ns', 'crew'), 'other.json'), '{"hello":1}');
    fs.writeFileSync(path.join(s.dir('ctx', 'ns', 'crew'), 'notes.txt'), 'x');
    expect((await s.list('ctx', 'ns', 'crew')).map((m) => m.id)).toEqual([c.id]);
  });
});

describe('safeSegment', () => {
  it('keeps safe names and replaces everything else', () => {
    expect(safeSegment('team-1')).toBe('team-1');
    expect(safeSegment('arn:aws:eks:us-east-1:1:cluster/x')).toBe('arn_aws_eks_us-east-1_1_cluster_x');
  });

  it('never yields a segment that climbs directories', () => {
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('.')).toBe('_');
    expect(safeSegment('')).toBe('_');
    expect(safeSegment('../../etc')).toBe('.._.._etc');
  });
});

describe('titleFrom', () => {
  it('uses the question on one line, cut to 80 characters', () => {
    expect(titleFrom('  Which nodes\nhave a GPU?  ')).toBe('Which nodes have a GPU?');
    expect(titleFrom('x'.repeat(100))).toHaveLength(82);
    expect(titleFrom('   ')).toBe('Untitled');
  });
});
