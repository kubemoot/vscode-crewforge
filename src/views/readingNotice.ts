/** How long a tree waits on the cluster before it says it is still reading. */
export const STILL_READING_MS = 2_000;

/**
 * A tree view's "Still reading from <context>..." line: shown while any read it tracks has
 * taken longer than a moment, and cleared when the last one ends. Each read is bounded by
 * the request timeout, so the line never stays.
 */
export class ReadingNotice {
  private inflight = 0;
  private timer?: ReturnType<typeof setTimeout>;

  /** `from` names what the view reads from, as the person knows it (a context name). */
  constructor(
    private readonly show: (text: string | undefined) => void,
    private readonly from: () => string,
    private readonly ms = STILL_READING_MS,
  ) {}

  /** Runs `work`, saying after a moment that the view is still reading. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    if (this.inflight++ === 0) this.timer = setTimeout(() => this.show(`Still reading from ${safely(this.from)}...`), this.ms);
    try {
      return await work();
    } finally {
      if (--this.inflight === 0) {
        clearTimeout(this.timer);
        this.show(undefined);
      }
    }
  }
}

function safely(from: () => string): string {
  try {
    return from() || 'the cluster';
  } catch {
    return 'the cluster';
  }
}
