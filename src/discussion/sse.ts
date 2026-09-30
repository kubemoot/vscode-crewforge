import type { DiscussionEvent } from './types';

/**
 * Incremental Server-Sent Events parser. Feed it text chunks as they arrive, in any
 * split, and it returns the complete events each chunk finishes. `data:` fields make
 * the events and `id:` fields set {@link lastEventId}; comments, other fields, and data
 * that is not a JSON object are skipped.
 */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private pendingId?: string;

  /**
   * The id of the last event dispatched, as the SSE standard's Last-Event-ID: the point
   * a reconnecting client resumes from. Empty until the stream sends one.
   */
  lastEventId = '';

  push(chunk: string): DiscussionEvent[] {
    this.buffer += chunk;
    const events: DiscussionEvent[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      // A lone \r at the end of the buffer may be the first half of \r\n.
      if (width === 1 && this.buffer[newline] === '\r' && newline === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line, events);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    return events;
  }

  /** Flushes an event left open when the stream ends without a blank line. */
  end(): DiscussionEvent[] {
    const events: DiscussionEvent[] = [];
    if (this.buffer.length > 0) this.line(this.buffer, events);
    this.buffer = '';
    this.dispatch(events);
    return events;
  }

  private line(line: string, events: DiscussionEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith('id:')) {
      const id = fieldValue(line, 3);
      // The standard ignores an id containing NUL.
      if (!id.includes('\0')) this.pendingId = id;
      return;
    }
    if (!line.startsWith('data:')) return;
    this.data.push(fieldValue(line, 5));
  }

  private dispatch(events: DiscussionEvent[]): void {
    if (this.pendingId !== undefined) this.lastEventId = this.pendingId;
    this.pendingId = undefined;
    if (this.data.length === 0) return;
    const payload = this.data.join('\n');
    this.data = [];
    const event = parseEvent(payload);
    if (!event) return;
    if (this.lastEventId) event.id = this.lastEventId;
    events.push(event);
  }
}

/** A field's value: the text after its name and colon, less one leading space. */
function fieldValue(line: string, nameLength: number): string {
  const value = line.slice(nameLength);
  return value.startsWith(' ') ? value.slice(1) : value;
}

function parseEvent(payload: string): DiscussionEvent | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === 'object' && typeof (value as DiscussionEvent).type === 'string') {
      return value as DiscussionEvent;
    }
  } catch {
    // Not JSON: a keep-alive or a line this client does not understand.
  }
  return undefined;
}
