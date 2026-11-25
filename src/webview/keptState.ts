/**
 * What a CrewForge page keeps when its tab is hidden: where it was scrolled to and which
 * sections the person opened. Both the chat and the dashboard pages use this one module,
 * so they keep the same things the same way.
 */

/** The page state API VS Code gives a webview; a host without it keeps nothing. */
export interface StateApi {
  getState?(): unknown;
  setState?(state: never): void;
}

/** What is kept, for every page: each page uses the fields it needs. */
export interface Kept {
  /** The chat's conversations pane width. */
  sidebarWidth?: number;
  /** Where the scrolled thing was, and whether it was at its end. */
  scrollTop?: number;
  pinned?: boolean;
  /** The keys of the sections the person has open. */
  open?: string[];
}

/** How long a burst of changes waits before it is written: one frame. */
const FRAME_MS = 16;

/**
 * Keeps state in the webview's own state, merged into what is already there. Writes are
 * grouped into one per frame, and the last one is written when the page is hidden.
 */
export class Keeper {
  private pending: Kept = {};
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly api: StateApi, target: EventTarget = globalThis) {
    target.addEventListener('pagehide', () => this.flush());
  }

  /** What is kept, with changes not yet written. */
  read(): Kept {
    return { ...(this.api.getState?.() as Kept | undefined), ...this.pending };
  }

  save(patch: Kept): void {
    this.pending = { ...this.pending, ...patch };
    this.timer ??= setTimeout(() => this.flush(), FRAME_MS);
  }

  /** Writes what is waiting now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (Object.keys(this.pending).length === 0) return;
    const merged = this.read();
    this.pending = {};
    this.api.setState?.(merged as never);
  }
}

/** What is scrolled: the chat's messages pane, or the dashboard page's window. */
export interface Scroller {
  /** The visible height; 0 while the tab is hidden. */
  visible(): number;
  top(): number;
  set(top: number): void;
  /** The height of everything in it. */
  content(): number;
}

/** How far from the end still counts as at the end. */
export const END_SLACK_PX = 40;

/**
 * Remembers where a scroller was and puts it back. A hidden tab has no size and forgets
 * its scroll position, so nothing is remembered while it is hidden, and the place is put
 * back on the first size after it was hidden; scrolling before then is the browser's
 * reset, not the person.
 */
export class ScrollPlace {
  top = 0;
  pinned = true;
  private hidden = false;

  constructor(
    private readonly scroller: Scroller,
    private readonly keeper: Keeper,
    /** Whether being at the end means staying at the end as more arrives (a chat does; a page does not). */
    private readonly followEnd = true,
  ) {
    const kept = keeper.read();
    this.top = kept.scrollTop ?? 0;
    this.pinned = followEnd && (kept.pinned ?? true);
  }

  /** Notes where the scroller is now, unless it is hidden. */
  remember(): void {
    if (this.hidden || this.scroller.visible() === 0) return;
    this.top = this.scroller.top();
    this.pinned = this.followEnd && this.scroller.content() - this.top - this.scroller.visible() < END_SLACK_PX;
    this.keeper.save({ scrollTop: this.top, pinned: this.pinned });
  }

  /** Puts the scroller where it was: at its end when it was at the end. */
  restore(): void {
    if (this.scroller.visible() === 0) return;
    this.scroller.set(this.pinned ? this.scroller.content() : this.top);
  }

  /** The scroller changed size: hidden when it has none, shown again when it gets one. */
  resized(): void {
    if (this.scroller.visible() === 0) {
      this.hidden = true;
    } else if (this.hidden) {
      this.hidden = false;
      this.restore();
    }
  }

  /** Starts at the end of a new thing, as a conversation just switched to. */
  reset(): void {
    this.top = 0;
    this.pinned = this.followEnd;
  }
}

/** Follows the size of an element, where the page can observe it. */
export function observeSize(el: Element, onChange: () => void): void {
  if (typeof ResizeObserver === 'function') new ResizeObserver(onChange).observe(el);
}

/**
 * A section's key: its data-key, else its summary's text. A section is the same one across
 * renders when its key is.
 */
export function sectionKey(details: HTMLDetailsElement): string {
  return details.dataset.key ?? details.querySelector('summary')?.textContent?.trim() ?? '';
}

/** The keys of the sections of `root` that are open; menus are not sections. */
export function openKeys(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLDetailsElement>('details:not(.menu)')].filter((d) => d.open).map(sectionKey);
}

/** Opens the sections of `root` whose keys are given. */
export function openSections(root: ParentNode, keys: string[]): void {
  const wanted = new Set(keys);
  for (const d of root.querySelectorAll<HTMLDetailsElement>('details:not(.menu)')) if (wanted.has(sectionKey(d))) d.open = true;
}
