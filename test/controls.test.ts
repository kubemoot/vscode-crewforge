import { describe, expect, it } from 'vitest';
import {
  ACCESS_REASON_HEADER,
  controlConversation,
  ControlError,
  describeControlFailure,
  eraseConversation,
  erasureLines,
  erasureSummary,
  MAX_REASON,
  reasonProblem,
  type ConversationErasure,
} from '../src/discussion/controls';
import { controlPath, erasePath, eventsPath } from '../src/discussion/gatewayPath';
import { ConnectionError, KubeError } from '../src/k8s/request';
import { FakeTransport } from './fakes';

/** A failure as the gateway client throws it: the status, and the raw request line with the body. */
function failure(status: number, body: string, message = `The API server refused the request. POST /x returned ${status}`): KubeError {
  return new KubeError(message, status, `POST /x returned ${status} (${body})`);
}

const report: ConversationErasure = {
  conversationId: 'conv-1',
  threads: ['t1', 't2'],
  deleted: { history: 1, owner: 1, discussionMessages: 12, workspaceObjects: 0, coordinatorEvents: 4, scheduled: 2, memoryFacts: 3 },
  kept: ['KUBEMOOT_REQUEST: a question still queued expires with the stream', 'logs and backups: erasing from NATS does not erase them'],
};

describe('paths', () => {
  it('names the control, the delete with and without force, and the event stream', () => {
    expect(controlPath('team-a', 'demo', 'conv 1', 'pause')).toBe('/api/v1/discussions/demo/conv%201/pause');
    expect(erasePath('team-a', 'demo', 'conv-1')).toBe('/api/v1/discussions/demo/conv-1');
    expect(erasePath('team-a', 'demo', 'conv-1', true)).toBe('/api/v1/discussions/demo/conv-1?force=true');
    expect(eventsPath('team-a', 'demo')).toBe('/api/v1/discussions/demo/events');
    expect(eventsPath('team-a', 'demo', '42')).toBe('/api/v1/discussions/demo/events?lastEventId=42');
  });

  it('refuses a missing conversation and a name that is not a name', () => {
    expect(() => controlPath('team-a', 'demo', '', 'stop')).toThrow(/conversationId is required/);
    expect(() => erasePath('team-a', 'demo', '')).toThrow(/conversationId is required/);
    expect(() => controlPath('team-a', 'Bad Crew', 'c', 'stop')).toThrow();
  });
});

describe('reasonProblem', () => {
  it('accepts 1 to 200 characters and says what is wrong otherwise', () => {
    expect(reasonProblem('audit')).toBeUndefined();
    expect(reasonProblem('x'.repeat(MAX_REASON))).toBeUndefined();
    expect(reasonProblem('   ')).toBe('Enter a reason.');
    expect(reasonProblem('x'.repeat(MAX_REASON + 1))).toMatch(/at most 200 characters \(this is 201\)/);
  });
});

describe('controlConversation', () => {
  it.each(['stop', 'pause', 'resume'] as const)('POSTs the %s to the conversation with no body and no reason', async (action) => {
    const api = new FakeTransport();
    api.responses.push(JSON.stringify({ conversationId: 'conv-1', action, threads: ['t1'] }));
    const sent = await controlConversation(api, 'team-a', 'demo', 'conv-1', action);
    expect(sent).toEqual({ conversationId: 'conv-1', action, threads: ['t1'] });
    expect(api.calls).toEqual([{ method: 'POST', path: `/api/v1/discussions/demo/conv-1/${action}`, body: undefined }]);
  });

  it('sends the reason in the Kubemoot-Access-Reason header, trimmed', async () => {
    const api = new FakeTransport();
    api.responses.push('{"conversationId":"conv-1","action":"stop","threads":[]}');
    await controlConversation(api, 'team-a', 'demo', 'conv-1', 'stop', '  runaway job  ');
    expect(api.calls[0].headers).toEqual({ [ACCESS_REASON_HEADER]: 'runaway job' });
  });

  it('rejects an answer that is not JSON', async () => {
    const api = new FakeTransport();
    api.responses.push('<html>');
    await expect(controlConversation(api, 'team-a', 'demo', 'conv-1', 'stop')).rejects.toThrow(/not JSON/);
  });

  it('says a stop with nothing running is a conflict, with what the gateway said', async () => {
    const api = new FakeTransport();
    api.responses.push(failure(409, '{"error":"the conversation has no running discussion"}'));
    const err = await controlConversation(api, 'team-a', 'demo', 'conv-1', 'pause').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).status).toBe(409);
    expect((err as ControlError).message).toBe('The conversation has no running discussion to pause (the conversation has no running discussion).');
    expect((err as ControlError).running).toBe(false);
  });

  it('asks for a reason when the gateway says another caller owns the conversation', async () => {
    const api = new FakeTransport();
    api.responses.push(failure(400, '{"error":"acting on another caller\'s conversations needs a reason of 1 to 200 characters in the Kubemoot-Access-Reason header"}'));
    const err = (await controlConversation(api, 'team-a', 'demo', 'conv-1', 'resume').catch((e: unknown) => e)) as ControlError;
    expect(err.needsReason).toBe(true);
    expect(err.message).toBe('This conversation belongs to another caller. To resume it, give a reason of 1 to 200 characters.');
  });
});

describe('eraseConversation', () => {
  it('DELETEs the conversation and returns the report', async () => {
    const api = new FakeTransport();
    api.responses.push(JSON.stringify(report));
    expect(await eraseConversation(api, 'team-a', 'demo', 'conv-1')).toEqual(report);
    expect(api.calls).toEqual([{ method: 'DELETE', path: '/api/v1/discussions/demo/conv-1', body: undefined }]);
  });

  it('forces a running conversation and gives a reason', async () => {
    const api = new FakeTransport();
    api.responses.push(JSON.stringify(report));
    await eraseConversation(api, 'team-a', 'demo', 'conv-1', { force: true, reason: 'retention request' });
    expect(api.calls[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/discussions/demo/conv-1?force=true', headers: { [ACCESS_REASON_HEADER]: 'retention request' } });
  });

  it('marks a 409 as running, so a delete can offer Stop and delete', async () => {
    const api = new FakeTransport();
    api.responses.push(failure(409, '{"error":"the conversation has a running discussion; stop it first, or pass force=true"}'));
    const err = (await eraseConversation(api, 'team-a', 'demo', 'conv-1').catch((e: unknown) => e)) as ControlError;
    expect(err.running).toBe(true);
    expect(err.message).toBe('The conversation still has a running discussion. Stop it first, or choose Stop and delete.');
  });

  it('says which stores a failed delete could not clear, and that deleting again removes the rest', async () => {
    const api = new FakeTransport();
    api.responses.push(failure(500, '{"conversationId":"conv-1","deleted":{"history":0},"kept":[],"failed":["kubemoot_conversations","workspace"]}'));
    const err = (await eraseConversation(api, 'team-a', 'demo', 'conv-1').catch((e: unknown) => e)) as ControlError;
    expect(err.status).toBe(500);
    expect(err.message).toBe('The delete did not finish. These stores could not be cleared: kubemoot_conversations, workspace. The conversation is still on the crew, so delete it again to remove what is left.');
  });

  it('says a failed delete failed even when the report was cut off', async () => {
    const api = new FakeTransport();
    api.responses.push(failure(500, '{"conversationId":"conv-1"'));
    const err = (await eraseConversation(api, 'team-a', 'demo', 'conv-1').catch((e: unknown) => e)) as ControlError;
    expect(err.message).toBe('The delete did not finish. The conversation is still on the crew, so delete it again to remove what is left.');
  });
});

describe('describeControlFailure', () => {
  const request = { crew: 'demo', action: 'stop' } as const;

  it('keeps what a 401 and a 403 already say', () => {
    for (const status of [401, 403]) {
      const err = new KubeError(`plain ${status} text`, status);
      expect(describeControlFailure(err, request)).toBe(err);
    }
  });

  it('adds the role an operator needs to a 404, to the gateway client text', () => {
    const err = new KubeError('Conversation not found on crew demo. It does not exist, has expired, or belongs to another caller.', 404, 'x');
    expect((describeControlFailure(err, request) as ControlError).message).toBe(
      'Conversation not found on crew demo. It does not exist, has expired, or belongs to another caller. To stop another caller\'s conversation you need the kubemoot-conversation-controller role.',
    );
  });

  it('says what a 400 that is not about a reason means', () => {
    const plain = describeControlFailure(failure(400, '{"error":"conversation id is not valid"}'), { crew: 'demo', action: 'delete' }) as ControlError;
    expect(plain.needsReason).toBe(false);
    expect(plain.message).toBe('The discussion gateway did not accept the delete: conversation id is not valid');
    const bare = describeControlFailure(failure(400, 'nope'), request) as ControlError;
    expect(bare.message).toBe('The discussion gateway did not accept the stop.');
  });

  it('says a 500 on a control and a 503 plainly', () => {
    expect((describeControlFailure(failure(500, 'x'), request) as ControlError).message).toBe('The crew demo failed to stop the conversation.');
    expect((describeControlFailure(failure(503, '{"error":"could not send the control"}'), request) as ControlError).message).toBe(
      'The crew demo could not stop the conversation right now (could not send the control). Try again in a moment.',
    );
    expect((describeControlFailure(failure(503, ''), request) as ControlError).message).toContain('its gateway is not ready');
  });

  it('returns other statuses and failures that have no status as they came', () => {
    const teapot = failure(418, '');
    expect(describeControlFailure(teapot, request)).toBe(teapot);
    const dropped = new ConnectionError('cut', 'x');
    expect(describeControlFailure(dropped, request)).toBe(dropped);
    const plain = new Error('boom');
    expect(describeControlFailure(plain, request)).toBe(plain);
  });
});

describe('erasure report', () => {
  it('lists what each store lost, then what the gateway cannot remove', () => {
    expect(erasureLines(report)).toEqual([
      'Removed:',
      '  conversation history: 1',
      '  owner record: 1',
      '  discussion messages: 12',
      '  workspace objects: 0',
      '  coordinator events: 4',
      '  scheduled reminders and follow-ups: 2',
      '  crew memory facts: 3',
      '',
      'Not removed:',
      '  KUBEMOOT_REQUEST: a question still queued expires with the stream',
      '  logs and backups: erasing from NATS does not erase them',
    ]);
  });

  it('leaves out the not-removed list when there is none, and counts a missing store as zero', () => {
    const lines = erasureLines({ conversationId: 'c', deleted: { history: 1 } as ConversationErasure['deleted'], kept: [] });
    expect(lines).not.toContain('Not removed:');
    expect(lines).toContain('  owner record: 0');
    expect(erasureLines({ conversationId: 'c' } as ConversationErasure)).toContain('  crew memory facts: 0');
  });

  it('sums the items and counts the threads in one line', () => {
    expect(erasureSummary(report)).toBe('Deleted the conversation from the crew: 23 items removed across 2 threads.');
    expect(erasureSummary({ ...report, threads: ['t1'] })).toContain('across 1 thread.');
    expect(erasureSummary({ conversationId: 'c', deleted: report.deleted, kept: [] })).toContain('across 0 threads.');
  });
});
